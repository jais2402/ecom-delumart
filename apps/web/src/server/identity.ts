import "./server-only";
import { DomainError, isAdult } from "@delulu/core";
import { SERVER_CONFIG } from "./config";
import { birthdateBinding, decryptField } from "./crypto";
import type { SessionContext } from "./http";

/** Today's date (YYYY-MM-DD) in the configured zone; the clock is injectable. */
export function todayIn(timeZone: string = SERVER_CONFIG.identity.timeZone, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Validates a birthdate (YYYY-MM-DD) against today (both in the configured zone) and answers whether
 * it is an adult's. A malformed or impossible date, a date after today, or one more than
 * `maxAgeYears` before today is VALIDATION_FAILED: only a real under-age date answers false.
 */
export function checkBirthdate(
  birthdate: string,
  today: string,
  maxAgeYears: number = SERVER_CONFIG.identity.maxAgeYears,
): boolean {
  const adult = isAdult(birthdate, today); // VALIDATION_FAILED for a non-date
  const [y = "", rest = ""] = [today.slice(0, 4), today.slice(4)];
  const earliest = `${String(Number(y) - maxAgeYears).padStart(4, "0")}${rest}`;
  if (birthdate > today)
    throw new DomainError("VALIDATION_FAILED", "A birthdate cannot be in the future.", {
      field: "birthdate",
    });
  if (birthdate < earliest) {
    throw new DomainError("VALIDATION_FAILED", "That birthdate is too long ago. Check the year.", {
      field: "birthdate",
    });
  }
  return adult;
}

/** The signed-in user's birthdate, decrypted (bound to their user id); throws if not recorded. */
export function birthdateOf(session: SessionContext): string {
  const enc = session.actor.birthdateEnc;
  if (enc === null) throw new DomainError("VALIDATION_FAILED", "Add your birthdate first.");
  return decryptField(enc, birthdateBinding(session.actor.userId));
}
