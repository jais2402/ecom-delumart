import { myInventory } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { inventoryView } from "@/server/views";

/** GET /api/v1/studio/inventory: warehouses and per-product stock of the owner's store. */
export const GET = route({ auth: "session" }, async ({ session }) => {
  const inventory = await myInventory(webPool(), { authSessionId: session.id });
  return { json: inventoryView(inventory) };
});
