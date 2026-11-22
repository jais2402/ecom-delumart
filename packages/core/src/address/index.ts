/**
 * Delivery addresses (PRD R5.2). Pure validation and formatting of a real address a player saves
 * for their own checkout. Nothing is ever delivered, so the address is checked for format only: no
 * lookup against any outside service, no map, no phone number (decisions.md #5).
 *
 * The validated payload is what the web server encrypts (AES-256-GCM, LLD §5.6) before anything
 * reaches the database; the database stores ciphertext only. Countries are a table of rules so
 * others can be added; India only in this release (decisions.md #3).
 */
import { DomainError } from "../errors/index";

export const ADDRESS_LABELS = ["HOME", "WORK", "OTHER"] as const;
export type AddressLabel = (typeof ADDRESS_LABELS)[number];

/** Tunables (CLAUDE.md invariant 10). `maxPerUser` is the default the database also applies. */
export const ADDRESS_RULES = {
  /** PRD R5.2: up to five addresses. The database reads `address_max_per_user` from configuration. */
  maxPerUser: 5,
  nameMaxChars: 80,
  lineMaxChars: 120,
  cityMaxChars: 60,
  /** A digit run at least this long looks like a phone or card number and is refused. */
  digitRunMax: 9,
} as const;

export interface Region {
  /** ISO 3166-2 subdivision code without the country prefix. */
  code: string;
  name: string;
}

/** India's 28 states and 8 union territories (ISO 3166-2:IN, 2023 codes). */
export const INDIA_REGIONS: readonly Region[] = [
  { code: "AN", name: "Andaman and Nicobar Islands" },
  { code: "AP", name: "Andhra Pradesh" },
  { code: "AR", name: "Arunachal Pradesh" },
  { code: "AS", name: "Assam" },
  { code: "BR", name: "Bihar" },
  { code: "CH", name: "Chandigarh" },
  { code: "CG", name: "Chhattisgarh" },
  { code: "DH", name: "Dadra and Nagar Haveli and Daman and Diu" },
  { code: "DL", name: "Delhi" },
  { code: "GA", name: "Goa" },
  { code: "GJ", name: "Gujarat" },
  { code: "HR", name: "Haryana" },
  { code: "HP", name: "Himachal Pradesh" },
  { code: "JK", name: "Jammu and Kashmir" },
  { code: "JH", name: "Jharkhand" },
  { code: "KA", name: "Karnataka" },
  { code: "KL", name: "Kerala" },
  { code: "LA", name: "Ladakh" },
  { code: "LD", name: "Lakshadweep" },
  { code: "MP", name: "Madhya Pradesh" },
  { code: "MH", name: "Maharashtra" },
  { code: "MN", name: "Manipur" },
  { code: "ML", name: "Meghalaya" },
  { code: "MZ", name: "Mizoram" },
  { code: "NL", name: "Nagaland" },
  { code: "OD", name: "Odisha" },
  { code: "PY", name: "Puducherry" },
  { code: "PB", name: "Punjab" },
  { code: "RJ", name: "Rajasthan" },
  { code: "SK", name: "Sikkim" },
  { code: "TN", name: "Tamil Nadu" },
  { code: "TS", name: "Telangana" },
  { code: "TR", name: "Tripura" },
  { code: "UP", name: "Uttar Pradesh" },
  { code: "UK", name: "Uttarakhand" },
  { code: "WB", name: "West Bengal" },
];

interface CountryRules {
  regions: readonly Region[];
  /** The normalised postal code, or null when it is not valid for the country. */
  postalCode(raw: string): string | null;
}

const COUNTRY_RULES = {
  IN: {
    regions: INDIA_REGIONS,
    // PIN code: six digits, the first 1–9; one space after the third digit is accepted
    postalCode(raw: string): string | null {
      const s = raw.trim().replace(/^(\d{3}) (\d{3})$/u, "$1$2");
      return /^[1-9]\d{5}$/u.test(s) ? s : null;
    },
  },
} as const satisfies Record<string, CountryRules>;

export type AddressCountry = keyof typeof COUNTRY_RULES;
export const SUPPORTED_ADDRESS_COUNTRIES = Object.keys(COUNTRY_RULES) as AddressCountry[];

/** What a player types (strings as received). */
export interface AddressInput {
  recipientName: string;
  line1: string;
  line2?: string | null | undefined;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

/** A validated, normalised address: the plaintext the web server encrypts. */
export interface Address {
  recipientName: string;
  line1: string;
  line2: string | null;
  city: string;
  /** Region code of the country, e.g. "KA". */
  state: string;
  postalCode: string;
  country: AddressCountry;
}

export type AddressField = keyof Address;
export type AddressProblemCode =
  | "REQUIRED"
  | "TOO_LONG"
  | "CHARACTERS"
  | "DIGITS"
  | "INVALID"
  | "UNSUPPORTED";
export interface AddressProblem {
  field: AddressField;
  code: AddressProblemCode;
}

// control characters and markup brackets only; every script is allowed
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
const BAD_CHARS = /[\u0000-\u001f\u007f<>{}`\\]/u;

function longestDigitRun(s: string): number {
  let best = 0;
  // digits joined by spaces, hyphens, dots, plus signs or brackets count as one run
  for (const m of s.matchAll(/\d[\d\s\-.+()]*/gu)) best = Math.max(best, m[0].replace(/\D/gu, "").length);
  return best;
}

function cleanText(
  raw: unknown,
  field: AddressField,
  max: number,
  required: boolean,
  problems: AddressProblem[],
): string | null {
  const s = typeof raw === "string" ? raw.normalize("NFC").replace(/\s+/gu, " ").trim() : "";
  if (s === "") {
    if (required) problems.push({ field, code: "REQUIRED" });
    return null;
  }
  if ([...s].length > max) problems.push({ field, code: "TOO_LONG" });
  else if (BAD_CHARS.test(typeof raw === "string" ? raw : "")) problems.push({ field, code: "CHARACTERS" });
  else if (longestDigitRun(s) > ADDRESS_RULES.digitRunMax) problems.push({ field, code: "DIGITS" });
  return s;
}

/**
 * Validates and normalises an address. Throws VALIDATION_FAILED with `field` (the first problem)
 * and `issues` (every problem as {field, code}); never echoes the text.
 */
export function validateAddress(input: AddressInput): Address {
  const problems: AddressProblem[] = [];
  const country = typeof input.country === "string" ? input.country.trim().toUpperCase() : "";
  const rules: CountryRules | undefined = (COUNTRY_RULES as Record<string, CountryRules>)[country];
  if (!rules) problems.push({ field: "country", code: "UNSUPPORTED" });

  const recipientName = cleanText(
    input.recipientName,
    "recipientName",
    ADDRESS_RULES.nameMaxChars,
    true,
    problems,
  );
  const line1 = cleanText(input.line1, "line1", ADDRESS_RULES.lineMaxChars, true, problems);
  const line2 = cleanText(input.line2, "line2", ADDRESS_RULES.lineMaxChars, false, problems);
  const city = cleanText(input.city, "city", ADDRESS_RULES.cityMaxChars, true, problems);

  const stateCode = typeof input.state === "string" ? input.state.trim().toUpperCase() : "";
  if (rules && !rules.regions.some((r) => r.code === stateCode))
    problems.push({ field: "state", code: "INVALID" });
  const postalCode =
    rules && typeof input.postalCode === "string" ? rules.postalCode(input.postalCode) : null;
  if (rules && postalCode === null) problems.push({ field: "postalCode", code: "INVALID" });

  if (problems.length > 0 || !recipientName || !line1 || !city || !postalCode) {
    const first = problems[0];
    throw new DomainError("VALIDATION_FAILED", "Check the highlighted address fields.", {
      ...(first ? { field: first.field } : {}),
      issues: problems.map((p) => ({ field: p.field, code: p.code })),
    });
  }
  return {
    recipientName,
    line1,
    line2,
    city,
    state: stateCode,
    postalCode,
    country: country as AddressCountry,
  };
}

/** The plaintext that is encrypted: versioned JSON of a validated address. */
export function addressToJson(a: Address): string {
  return JSON.stringify({ v: 1, ...a });
}

/** Parses and re-validates a decrypted payload; throws VALIDATION_FAILED for anything else. */
export function addressFromJson(json: string): Address {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new DomainError("VALIDATION_FAILED", "The stored address cannot be read.");
  }
  const o = (parsed ?? {}) as Record<string, unknown>;
  if (o.v !== 1) throw new DomainError("VALIDATION_FAILED", "The stored address cannot be read.");
  return validateAddress(o as unknown as AddressInput);
}

/** The region's name for display ("KA" → "Karnataka"); the code itself when unknown. */
export function regionName(country: AddressCountry, code: string): string {
  return COUNTRY_RULES[country].regions.find((r) => r.code === code)?.name ?? code;
}

/** One readable line: "Name, line 1, line 2, City, State PIN". */
export function formatAddress(a: Address): string {
  return [a.recipientName, a.line1, a.line2, a.city, `${regionName(a.country, a.state)} ${a.postalCode}`]
    .filter((s): s is string => s !== null && s !== "")
    .join(", ");
}
