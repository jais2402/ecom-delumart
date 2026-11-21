import { createAppeal } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { appealBody, checkStatement } from "@/server/safety";
import { appealView } from "@/server/views";

/**
 * POST /api/v1/studio/products/{id}/appeal {statement}: appeals the moderation decision that
 * rejected or hid this own listing, once per decision (APPEAL_EXISTS; NOT_APPEALABLE otherwise).
 */
export const POST = route(
  { auth: "session", body: appealBody, rateLimits: [{ rule: RATE_RULES.studioActor }] },
  async ({ body, params, session }) => {
    const appeal = await createAppeal(webPool(), {
      authSessionId: session.id,
      productId: pathId(params),
      statement: checkStatement(body.statement),
    });
    return { status: 201, json: { appeal: appealView(appeal) } };
  },
);
