/**
 * Onboarding steps (LLD §7.1) through the actor-scoped functions of migration 0024, as the
 * money-command role app_pay. Only fingerprints (HMAC) and the encrypted birthdate reach the
 * database; the plain phone number, email and birthdate never do.
 */
import { DomainError } from "@delulu/core";
import type { Pool } from "pg";
import { asPay, one } from "./command";

export interface OnboardingStatus {
  hasProfile: boolean;
  /**
   * True only for a number confirmed by SMS (or by the trusted local stand-in); a number recorded
   * in 'unverified' mode is false (ninth review, major 1).
   */
  phoneVerified: boolean;
  /** The phone step is done: a number is recorded, confirmed or not. */
  phoneRecorded: boolean;
  /** The account's unverified number was released to its confirmed owner: ask for a number again. */
  phoneReverifyRequired: boolean;
  hasBirthdate: boolean;
  isAdult: boolean;
  provisioned: boolean;
  pinSet: boolean;
}

function requireBytes(value: unknown, field: string, min: number, max: number): void {
  if (!Buffer.isBuffer(value) || value.length < min || value.length > max) {
    throw new DomainError("VALIDATION_FAILED", `${field} has the wrong length`, { field });
  }
}

/** The actor's onboarding step flags. */
export async function onboardingStatus(
  pool: Pool,
  input: { authSessionId: string },
): Promise<OnboardingStatus> {
  return asPay(pool, input.authSessionId, async (c) => {
    const { rows } = await c.query<{
      has_profile: boolean;
      phone_verified: boolean;
      has_birthdate: boolean;
      is_adult: boolean;
      provisioned: boolean;
      pin_set: boolean;
      phone_recorded: boolean;
      phone_reverify_required: boolean;
    }>("SELECT * FROM core.onboarding_status()");
    const r = rows[0];
    if (!r) throw new Error("onboarding_status returned nothing");
    return {
      hasProfile: r.has_profile,
      phoneVerified: r.phone_verified,
      phoneRecorded: r.phone_recorded,
      phoneReverifyRequired: r.phone_reverify_required,
      hasBirthdate: r.has_birthdate,
      isAdult: r.is_adult,
      provisioned: r.provisioned,
      pinSet: r.pin_set,
    };
  });
}

export interface RecordPhoneVerifiedInput {
  authSessionId: string;
  /** HMAC-SHA-256 of the E.164 number, after the sign-in service confirmed the SMS code. */
  phoneFingerprint: Buffer;
  /** HMAC-SHA-256 of the normalised email; used only when the profile is created by this call. */
  emailFingerprint: Buffer;
}

/**
 * Records the verified phone (creating the profile if needed). The caller must have verified the
 * code with the sign-in service first. A fingerprint held by another account is CONFLICT (US-49).
 */
export async function recordPhoneVerified(
  pool: Pool,
  input: RecordPhoneVerifiedInput,
): Promise<OnboardingStatus> {
  requireBytes(input.phoneFingerprint, "phoneFingerprint", 32, 32);
  requireBytes(input.emailFingerprint, "emailFingerprint", 32, 32);
  return asPay(pool, input.authSessionId, (c) =>
    one<OnboardingStatus>(c, "SELECT core.record_phone_verified($1, $2) AS r", [
      input.phoneFingerprint,
      input.emailFingerprint,
    ]),
  );
}

export interface RecordBirthdateInput {
  authSessionId: string;
  /** AES-256-GCM ciphertext of the birthdate (LLD §5.6), made by the web deployment. */
  birthdateEnc: Buffer;
  /** Derived by the web server from the plain birthdate before encrypting it. */
  isAdult: boolean;
}

/**
 * Stores the encrypted birthdate once. A minor's record commits (so another birthdate cannot be
 * tried) and then this throws UNDERAGE.
 */
export async function recordBirthdate(pool: Pool, input: RecordBirthdateInput): Promise<OnboardingStatus> {
  requireBytes(input.birthdateEnc, "birthdateEnc", 16, 512);
  if (typeof input.isAdult !== "boolean") throw new DomainError("VALIDATION_FAILED", "isAdult is required");
  const status = await asPay(pool, input.authSessionId, (c) =>
    one<OnboardingStatus>(c, "SELECT core.record_birthdate($1, $2) AS r", [
      input.birthdateEnc,
      input.isAdult,
    ]),
  );
  if (!status.isAdult) throw new DomainError("UNDERAGE", "DeluluMart accounts are for adults");
  return status;
}
