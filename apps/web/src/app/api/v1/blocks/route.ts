import { blockStore, myBlocks, unblockStore } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { blockBody } from "@/server/safety";
import { blockView } from "@/server/views";

/** GET /api/v1/blocks: the stores the caller blocked (only the caller ever sees a block). */
export const GET = route({ auth: "session" }, async ({ session }) => {
  const items = await myBlocks(webPool(), { authSessionId: session.id });
  return { json: { items: items.map(blockView) } };
});

/** POST /api/v1/blocks {companyId}: blocks a store; purchases between the two are refused both ways. */
export const POST = route(
  { auth: "session", body: blockBody, rateLimits: [{ rule: RATE_RULES.blockActor }] },
  async ({ body, session }) => {
    const companyId = body.companyId.toLowerCase();
    await blockStore(webPool(), { authSessionId: session.id, companyId });
    return { json: { companyId, blocked: true } };
  },
);

/** DELETE /api/v1/blocks {companyId}: unblocks a store (not blocked is a no-op). */
export const DELETE = route(
  { auth: "session", body: blockBody, rateLimits: [{ rule: RATE_RULES.blockActor }] },
  async ({ body, session }) => {
    const companyId = body.companyId.toLowerCase();
    await unblockStore(webPool(), { authSessionId: session.id, companyId });
    return { json: { companyId, blocked: false } };
  },
);
