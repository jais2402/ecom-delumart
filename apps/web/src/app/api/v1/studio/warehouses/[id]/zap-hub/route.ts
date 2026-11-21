import { setZapHub } from "@delulu/db/runtime";
import { z } from "zod";
import { webPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { warehouseView } from "@/server/views";

/** POST /api/v1/studio/warehouses/{id}/zap-hub {enabled}: at most one Zap hub per company. */
export const POST = route(
  {
    auth: "session",
    body: z.strictObject({ enabled: z.boolean() }),
    rateLimits: [{ rule: RATE_RULES.studioActor }],
  },
  async ({ body, params, session }) => {
    const warehouses = await setZapHub(webPool(), {
      authSessionId: session.id,
      warehouseId: pathId(params),
      enabled: body.enabled,
    });
    return { json: { warehouses: warehouses.map(warehouseView) } };
  },
);
