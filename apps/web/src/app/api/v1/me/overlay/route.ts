import { serializePaise } from "@delulu/core";
import { myWallet, ownsProducts } from "@delulu/db/runtime";
import { z } from "zod";
import { SERVER_CONFIG } from "@/server/config";
import { webPool } from "@/server/db";
import { route } from "@/server/http";

const MAX = SERVER_CONFIG.http.maxOverlayProducts;

const query = z.object({
  productIds: z
    .string()
    .max(MAX * 37)
    .optional()
    .transform((v) => (v ? v.split(",").filter((s) => s !== "") : []))
    .pipe(z.array(z.uuid()).max(MAX)),
});

/** GET /api/v1/me/overlay?productIds=a,b: the private overlay for public pages (owned flags, balance). */
export const GET = route({ auth: "session", query }, async ({ session, query: q }) => {
  const authSessionId = session.id;
  const ids = q.productIds.map((id) => id.toLowerCase());
  const [owned, wallet] = await Promise.all([
    ownsProducts(webPool(), { authSessionId, productIds: ids }),
    myWallet(webPool(), { authSessionId }),
  ]);
  return {
    json: {
      owned: ids.filter((id) => owned.has(id)),
      balancePaise: wallet ? serializePaise(wallet.balancePaise) : null,
    },
  };
});
