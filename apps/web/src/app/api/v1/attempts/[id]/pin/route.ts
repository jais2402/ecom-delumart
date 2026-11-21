import { verifyCardPin } from "@delulu/db/runtime";
import { z } from "zod";
import { pinMac } from "@/server/crypto";
import { payPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { LIMITERS } from "@/server/rate-limit";

/**
 * POST /api/v1/attempts/{id}/pin {pin}: the PIN step of a CARD payment. The database counts wrong
 * PINs (three fail the attempt, five lock the card) and sees only HMAC-SHA-256(PIN_PEPPER, pin).
 */
export const POST = route(
  {
    auth: "session",
    body: z.strictObject({ pin: z.string().regex(/^\d{6}$/) }),
    rateLimit: { limiter: LIMITERS.pin, by: "session" },
  },
  async ({ body, session, params }) => {
    await verifyCardPin(payPool(), {
      authSessionId: session.id,
      attemptId: pathId(params),
      pinMac: pinMac(body.pin),
    });
    return { json: { authenticated: true } };
  },
);
