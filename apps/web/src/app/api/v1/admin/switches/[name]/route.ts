import { setSystemSwitch } from "@delulu/db/runtime";
import { z } from "zod";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";

const NAME = /^[a-z_]{1,40}$/;

/** POST /api/v1/admin/switches/{name} {enabled, reason}: turns a system switch on or off (Super Admin only). */
export const POST = route(
  {
    auth: "session",
    body: z.strictObject({ enabled: z.boolean(), reason: z.string().max(1000) }),
    rateLimits: [{ rule: RATE_RULES.adminActor }],
  },
  async ({ body, params, session }) => {
    const name = params.name !== undefined && NAME.test(params.name) ? params.name : "";
    const result = await setSystemSwitch(webPool(), {
      authSessionId: session.id,
      name,
      enabled: body.enabled,
      reason: body.reason,
    });
    return { json: { name: result.name, enabled: result.enabled } };
  },
);
