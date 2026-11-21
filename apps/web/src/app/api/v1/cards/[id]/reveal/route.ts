import { revealCardNumber } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { pathId, route } from "@/server/http";

/**
 * POST /api/v1/cards/{id}/reveal: the full number of the caller's own card, for display only
 * (needs a sign-in within five minutes). POST so that it is CSRF-checked and never cached.
 */
export const POST = route({ auth: "session" }, async ({ session, params }) => {
  const cardNumber = await revealCardNumber(webPool(), { authSessionId: session.id, cardId: pathId(params) });
  return { json: { cardNumber } };
});
