import { myAppeals } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { appealView } from "@/server/views";

/** GET /api/v1/studio/appeals: the owner's appeals and their status, newest first. */
export const GET = route({ auth: "session" }, async ({ session }) => {
  const items = await myAppeals(webPool(), { authSessionId: session.id });
  return { json: { items: items.map(appealView) } };
});
