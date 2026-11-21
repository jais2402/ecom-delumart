import { creatorAccess } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { creatorAccessView } from "@/server/views";

/** GET /api/v1/creator-access: whether creator access is unlocked, by which route, and progress on both routes. */
export const GET = route({ auth: "session" }, async ({ session }) => {
  return { json: creatorAccessView(await creatorAccess(webPool(), { authSessionId: session.id })) };
});
