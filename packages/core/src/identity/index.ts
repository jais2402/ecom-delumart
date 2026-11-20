/**
 * Identity normalisation and fingerprints (LLD §5.6, US-49). Pure: keys and "today" are parameters.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { DomainError } from "../errors/index";

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/** Lowercase and trim; for Gmail domains also drop dots and any +tag, and map googlemail.com to gmail.com. */
export function normalizeEmail(input: string): string {
  const email = input.trim().toLowerCase();
  const parts = email.split("@");
  if (parts.length !== 2) throw new DomainError("VALIDATION_FAILED", "invalid email address");
  let [local = "", domain = ""] = parts;
  if (GMAIL_DOMAINS.has(domain)) {
    domain = "gmail.com";
    local = (local.split("+")[0] ?? "").replaceAll(".", "");
  }
  if (local.length === 0 || domain.length === 0 || /\s/.test(email)) {
    throw new DomainError("VALIDATION_FAILED", "invalid email address");
  }
  return `${local}@${domain}`;
}

const E164 = /^\+[1-9]\d{1,14}$/;

/**
 * Accept only E.164 (e.g. +919876543210) whose country calling code is in `allowedCallingCodes`
 * (configuration, e.g. ["91"]). Surrounding whitespace is trimmed; nothing else is reformatted.
 */
export function normalizePhone(input: string, allowedCallingCodes: readonly string[]): string {
  const phone = input.trim();
  if (!E164.test(phone))
    throw new DomainError("PHONE_INVALID", "phone number must be in international format");
  const digits = phone.slice(1);
  const code = allowedCallingCodes.find((c) => digits.startsWith(c) && digits.length - c.length >= 4);
  if (!code) throw new DomainError("PHONE_INVALID", "phone number country is not supported");
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

export const ADULT_AGE_YEARS = 18;

/**
 * True from the 18th birthday (inclusive). Dates are YYYY-MM-DD; `today` is supplied by the caller.
 * A 29 February birthday turns 18 on 1 March in non-leap years.
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
  if (!isAdult(birthdate, today, adultAge)) throw new DomainError("UNDERAGE", "players must be 18 or older");
}
