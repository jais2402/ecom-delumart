import { DomainError } from "@delulu/core";
import { storeByHandle, storeCoupons } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { publicCouponView } from "@/server/views";

const HANDLE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** GET /api/v1/stores/{handle}/coupons: the store's public coupons usable now; public and cacheable. */
export const GET = route({ auth: "public" }, async ({ params }) => {
  const handle = (params.handle ?? "").toLowerCase();
  if (handle.length > 24 || !HANDLE.test(handle)) throw new DomainError("NOT_FOUND", "Store not found.");
  if ((await storeByHandle(webPool(), handle)) === null)
    throw new DomainError("NOT_FOUND", "Store not found.");
  const items = await storeCoupons(webPool(), handle);
  return { json: { items: items.map(publicCouponView) } };
});
