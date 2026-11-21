import { validateNewPin } from "@delulu/core";
import { setCardPin } from "@delulu/db/runtime";
import { z } from "zod";
import { pinMac } from "@/server/crypto";
import { payPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { birthdateOf } from "@/server/identity";
import { LIMITERS } from "@/server/rate-limit";

/**
 * POST /api/v1/cards/{id}/pin {pin, currentPin?}: sets the first PIN or changes it (the current PIN
 * is required then). The PIN rules run here against the decrypted birthdate; the database receives
 * only HMAC-SHA-256(PIN_PEPPER, pin). The PIN is never logged, stored, echoed or put in an error.
 */
export const POST = route(
  {
    auth: "session",
    body: z.strictObject({ pin: z.string().max(16), currentPin: z.string().max(16).optional() }),
    rateLimit: { limiter: LIMITERS.pin, by: "session" },
  },
  async ({ body, session, params }) => {
    const cardId = pathId(params);
    const check = validateNewPin(body.pin, birthdateOf(session));
    if (!check.ok) throw check.error;
    await setCardPin(payPool(), {
      authSessionId: session.id,
      cardId,
      pinMac: pinMac(body.pin),
      currentPinMac: body.currentPin === undefined ? null : pinMac(body.currentPin),
    });
    return { json: { pinSet: true } };
  },
);
