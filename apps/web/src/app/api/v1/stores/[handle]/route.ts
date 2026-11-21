import { DomainError } from "@delulu/core";
import { storeByHandle } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { storeView } from "@/server/views";

const HANDLE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** GET /api/v1/stores/{handle}: a store's public face (no owner identity); public and cacheable; never reads the session. */
export const GET = route({ auth: "public" }, async ({ params }) => {
  const handle = (params.handle ?? "").toLowerCase();
  if (handle.length > 24 || !HANDLE.test(handle)) throw new DomainError("NOT_FOUND", "Store not found.");
  const store = await storeByHandle(webPool(), handle);
  if (store === null) throw new DomainError("NOT_FOUND", "Store not found.");
  return { json: storeView(store) };
});
