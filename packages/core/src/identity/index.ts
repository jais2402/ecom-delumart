/**
 * Identity normalisation and fingerprints (LLD §5.6, US-49). Pure: keys and "today" are parameters.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { DomainError } from "../errors/index";

/** Per-country phone rules for the server-side allow-list. */
export type PhoneCountryRule = {
  /** Country calling code without "+", e.g. "91". */
  callingCode: string;
  /** Exact number of digits after the calling code. */
  nationalLength: number;
  /** Digits a national number may start with, e.g. "6789". */
  leadingDigits: string;
};

export type IdentityConfig = {
  adultAgeYears: number;
  /** Allow-list of countries accepted at sign-up. */
  phoneCountries: readonly PhoneCountryRule[];
};

export const DEFAULT_IDENTITY_CONFIG: IdentityConfig = {
  adultAgeYears: 18,
  phoneCountries: [{ callingCode: "91", nationalLength: 10, leadingDigits: "6789" }],
};

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);
/** One or more dot-separated non-empty labels, at least two labels. */
const EMAIL_DOMAIN = /^[^.@\s]+(\.[^.@\s]+)+$/;

/**
 * Lowercase and trim, and drop a trailing dot from the domain; for Gmail domains also drop dots and any
 * +tag, and map googlemail.com to gmail.com. Rejects anything without exactly one @, a non-empty local
 * part and a dotted domain.
 */
export function normalizeEmail(input: string): string {
  const email = input.trim().toLowerCase();
  const parts = email.split("@");
  if (parts.length !== 2) throw new DomainError("VALIDATION_FAILED", "invalid email address");
  let [local = "", domain = ""] = parts;
  if (domain.endsWith(".")) domain = domain.slice(0, -1);
  if (!EMAIL_DOMAIN.test(domain)) throw new DomainError("VALIDATION_FAILED", "invalid email address");
  if (GMAIL_DOMAINS.has(domain)) {
    domain = "gmail.com";
    local = (local.split("+")[0] ?? "").replaceAll(".", "");
  }
  if (local.length === 0 || domain.length === 0 || /\s/.test(email)) {
    throw new DomainError("VALIDATION_FAILED", "invalid email address");
  }
  return `${local}@${domain}`;
}

/** Separators people type inside a phone number; removed before validation. */
const PHONE_SEPARATORS = /[\s\-()]/g;

/**
 * Normalise to E.164 (e.g. "+91 98765 43210" → "+919876543210"). Spaces, hyphens and parentheses are
 * removed; the result must be "+" and digits whose calling code is in `countries` (the allow-list
 * configuration) with that country's exact national length and an allowed leading digit.
 */
export function normalizePhone(
  input: string,
  countries: readonly PhoneCountryRule[] = DEFAULT_IDENTITY_CONFIG.phoneCountries,
): string {
  const phone = input.replace(PHONE_SEPARATORS, "");
  if (!/^\+\d+$/.test(phone)) {
    throw new DomainError("PHONE_INVALID", "phone number must be in international format");
  }
  const digits = phone.slice(1);
  const rule = countries.find((c) => {
    if (!digits.startsWith(c.callingCode)) return false;
    const national = digits.slice(c.callingCode.length);
    return national.length === c.nationalLength && c.leadingDigits.includes(national.charAt(0));
  });
  if (!rule) throw new DomainError("PHONE_INVALID", "phone number is not valid for a supported country");
  return phone;
}

/** HMAC-SHA-256(IDENTITY_KEY, normalisedValue) as lowercase hex. Callers normalise first. */
export function fingerprint(key: Uint8Array, value: string): string {
  return bytesToHex(hmac(sha256, key, utf8ToBytes(value)));
}

type YMD = { y: number; m: number; d: number };

function parseDate(iso: string): YMD {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new DomainError("VALIDATION_FAILED", "date must be YYYY-MM-DD");
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new DomainError("VALIDATION_FAILED", "not a calendar date");
  }
  return { y, m, d };
}

export const ADULT_AGE_YEARS = DEFAULT_IDENTITY_CONFIG.adultAgeYears;

/**
 * True from the `adultAge`th birthday (inclusive; default from config). Dates are YYYY-MM-DD; `today`
 * is supplied by the caller. A 29 February birthday turns adult on 1 March in non-leap years.
 */
export function isAdult(birthdate: string, today: string, adultAge = ADULT_AGE_YEARS): boolean {
  const b = parseDate(birthdate);
  const t = parseDate(today);
  const y = b.y + adultAge;
  if (t.y !== y) return t.y > y;
  if (t.m !== b.m) return t.m > b.m;
  return t.d >= b.d;
}

export function assertAdult(birthdate: string, today: string, adultAge = ADULT_AGE_YEARS): void {
  if (!isAdult(birthdate, today, adultAge)) throw new DomainError("UNDERAGE", `players must be ${adultAge} or older`, { adultAge });
}
