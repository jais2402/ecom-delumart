import "./server-only";
import { DomainError } from "@delulu/core";
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

/** The signed-in user's birthdate, decrypted (bound to their user id); throws if not recorded. */
export function birthdateOf(session: SessionContext): string {
  const enc = session.actor.birthdateEnc;
  if (enc === null) throw new DomainError("VALIDATION_FAILED", "Add your birthdate first.");
  return decryptField(enc, birthdateBinding(session.actor.userId));
}
