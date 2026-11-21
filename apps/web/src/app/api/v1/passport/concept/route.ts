import { submitPassportConcept } from "@delulu/db/runtime";
import { z } from "zod";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { checkConcept } from "@/server/selling";
import { passportView } from "@/server/views";

/**
 * POST /api/v1/passport/concept {concept}: the private invention concept (20–280 characters),
 * screened here; anything but an OK verdict is VALIDATION_FAILED with `details.reasons` and nothing
 * is stored. Visible to its owner only; never published.
 */
export const POST = route(
  {
    auth: "session",
    body: z.strictObject({ concept: z.string().max(2000) }),
    rateLimits: [{ rule: RATE_RULES.passportActor }],
  },
  async ({ body, session }) => {
    const concept = checkConcept(body.concept);
    const progress = await submitPassportConcept(webPool(), {
      authSessionId: session.id,
      concept,
      screening: "OK",
    });
    return { json: passportView(progress) };
  },
);
