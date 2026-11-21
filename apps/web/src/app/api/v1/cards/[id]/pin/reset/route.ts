import { validateNewPin } from "@delulu/core";
import { resetCardPin } from "@delulu/db/runtime";
import { z } from "zod";
import { pinMac } from "@/server/crypto";
import { payPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { birthdateOf } from "@/server/identity";
import { LIMITERS } from "@/server/rate-limit";

/** POST /api/v1/cards/{id}/pin/reset {pin}: a new PIN without the current one; needs a recent sign-in. */
export const POST = route(
  {
    auth: "session",
    body: z.strictObject({ pin: z.string().max(16) }),
    rateLimit: { limiter: LIMITERS.pin, by: "session" },
  },
  async ({ body, session, params }) => {
    const cardId = pathId(params);
    const check = validateNewPin(body.pin, birthdateOf(session));
    if (!check.ok) throw check.error;
    await resetCardPin(payPool(), { authSessionId: session.id, cardId, pinMac: pinMac(body.pin) });
    return { json: { pinSet: true } };
  },
);
