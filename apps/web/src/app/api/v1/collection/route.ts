import { myCollection } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { collectionItemView } from "@/server/views";

/** GET /api/v1/collection: what the signed-in user owns, newest first. */
export const GET = route({ auth: "session" }, async ({ session }) => {
  const items = await myCollection(webPool(), { authSessionId: session.id });
  return { json: { items: items.map(collectionItemView) } };
});
