import { DomainError, serializePaise } from "@delulu/core";
import { type ProvisionResult, provisionAccount } from "@delulu/db/runtime";
import { trackAfter } from "@/server/analytics";
import { SERVER_CONFIG } from "@/server/config";
import { bankAlias, cardNumberCandidates, delulupayId } from "@/server/crypto";
import { payPool } from "@/server/db";
import { route } from "@/server/http";
import { birthdateOf } from "@/server/identity";

/**
 * POST /api/v1/onboarding/provision: opens the account (bank account, wallet with the starting
 * grant, card). Idempotent on the identity: a repeat returns the existing account. The full card
 * number is never returned here (only POST /cards/{id}/reveal shows it). A newly opened account
 * records a `sign_up` analytics event (after the response).
 */
export const POST = route({ auth: "session" }, async ({ request, session }) => {
  const profile = session.actor.profile;
  if (profile === null) throw new DomainError("PHONE_REQUIRED", "Verify your phone number first.");
  const birthdate = birthdateOf(session);
  const cardNumbers = cardNumberCandidates(session.actor.userId, birthdate);
  let result: ProvisionResult | undefined;
  for (let attempt = 1; result === undefined; attempt++) {
    try {
      result = await provisionAccount(payPool(), {
        authSessionId: session.id,
        emailFingerprint: profile.emailFingerprint,
        phoneFingerprint: profile.phoneFingerprint,
        cardNumbers,
        alias: bankAlias(),
        upiStyleId: delulupayId(profile.handle),
      });
    } catch (error) {
      // BUSY: an alias or id collided (or a lock timed out); fresh random names, same identity
      if (
        !(error instanceof DomainError && error.code === "BUSY") ||
        attempt >= SERVER_CONFIG.provision.attempts
      ) {
        throw error;
      }
    }
  }
  if (result.created) trackAfter(request, "sign_up", {}, { surface: "account", authSessionId: session.id });
  return {
    status: result.created ? 201 : 200,
    json: {
      created: result.created,
      balancePaise: serializePaise(result.walletPaise),
      card: { id: result.cardId, lastFour: result.cardNumber.slice(-4) },
    },
  };
});
