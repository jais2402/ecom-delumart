import { DomainError, isAdult } from "@delulu/core";
import { onboardingStatus, recordBirthdate } from "@delulu/db/runtime";
import { z } from "zod";
import { birthdateBinding, encryptField } from "@/server/crypto";
import { payPool } from "@/server/db";
import { route } from "@/server/http";
import { birthdateOf, todayIn } from "@/server/identity";
import { onboardingView } from "@/server/views";

/**
 * POST /api/v1/onboarding/birthdate {birthdate: "YYYY-MM-DD"}: the adult check runs here on the
 * plain date; only the AES-256-GCM ciphertext (bound to the user) reaches the database. A minor is
 * recorded and refused with UNDERAGE. Repeating the same date is answered from the stored one.
 */
export const POST = route(
  { auth: "session", body: z.strictObject({ birthdate: z.string().max(10) }) },
  async ({ body, session }) => {
    if (session.actor.profile === null)
      throw new DomainError("PHONE_REQUIRED", "Verify your phone number first.");
    const adult = isAdult(body.birthdate, todayIn()); // VALIDATION_FAILED for a non-date
    const authSessionId = session.id;
    if (session.actor.birthdateEnc !== null) {
      if (birthdateOf(session) !== body.birthdate) {
        throw new DomainError("CONFLICT", "Your birthdate is already recorded.");
      }
      const status = await onboardingStatus(payPool(), { authSessionId });
      if (!status.isAdult) throw new DomainError("UNDERAGE", "DeluluMart accounts are for adults");
      return { json: { onboarding: onboardingView(status) } };
    }
    const status = await recordBirthdate(payPool(), {
      authSessionId,
      birthdateEnc: encryptField(body.birthdate, birthdateBinding(session.actor.userId)),
      isAdult: adult,
    });
    return { json: { onboarding: onboardingView(status) } };
  },
);
