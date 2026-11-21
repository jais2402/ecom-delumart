import { reliefStatus } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { reliefStatusView } from "@/server/views";

/** GET /api/v1/relief: whether the relief grant can be claimed now, why not, claims used and the next UTC reset. */
export const GET = route({ auth: "session" }, async ({ session }) => {
  return { json: reliefStatusView(await reliefStatus(webPool(), { authSessionId: session.id })) };
});
