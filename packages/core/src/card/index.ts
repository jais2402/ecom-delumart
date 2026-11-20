/**
 * Delulu card numbers (LLD §5.4). Deterministic from a secret key, and deliberately Luhn-invalid
 * so no real card system would ever accept one.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { DomainError } from "../errors/index";

export type CardNumberInput = {
  /** CARD_KEY from the secret store. */
  cardKey: Uint8Array;
  userId: string;
  /** YYYY-MM-DD */
  birthdate: string;
  /** Starts at 0; incremented on unique-constraint conflict and for replacement cards. */
  sequence: number;
  /** Six digits beginning with 0 (configuration). */
  prefix: string;
};

/** Standard Luhn check digit for a digit string that will have the check digit appended. */
function luhnCheckDigit(payload: string): number {
  let sum = 0;
  // Rightmost payload digit is doubled (it sits second from the right once the check digit is appended).
  for (let i = 0; i < payload.length; i++) {
    let d = payload.charCodeAt(payload.length - 1 - i) - 48;
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

export function luhnValid(number: string): boolean {
  if (!/^\d{2,}$/.test(number)) return false;
  return luhnCheckDigit(number.slice(0, -1)) === number.charCodeAt(number.length - 1) - 48;
}

export function generateCardNumber(input: CardNumberInput): string {
  if (!/^0\d{5}$/.test(input.prefix)) {
    throw new DomainError("VALIDATION_FAILED", "card prefix must be six digits beginning with 0");
  }
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
    throw new DomainError("VALIDATION_FAILED", "card sequence must be a non-negative integer");
  }
  const h = hmac(sha256, input.cardKey, utf8ToBytes(`${input.userId}|${input.birthdate}|${input.sequence}`));
  const first8 = new DataView(h.buffer, h.byteOffset, 8).getBigUint64(0, false);
  const body = (first8 % 1_000_000_000n).toString().padStart(9, "0");
  const first15 = input.prefix + body;
  const last = (luhnCheckDigit(first15) + 5) % 10; // always fails the Luhn check
  return first15 + String(last);
}

/** Display form showing only the last four digits. */
export function maskCardNumber(number: string): string {
  return `•••• •••• •••• ${number.slice(-4)}`;
}
