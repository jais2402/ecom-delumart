import { setCardFrozen } from "@delulu/db/runtime";
import { z } from "zod";
import { payPool } from "@/server/db";
import { pathId, route } from "@/server/http";

/** POST /api/v1/cards/{id}/freeze {frozen}: freezes or unfreezes the caller's own card. */
export const POST = route(
  { auth: "session", body: z.strictObject({ frozen: z.boolean() }) },
  async ({ body, session, params }) => {
    const status = await setCardFrozen(payPool(), {
      authSessionId: session.id,
      cardId: pathId(params),
      frozen: body.frozen,
    });
    return { json: { status } };
  },
);
