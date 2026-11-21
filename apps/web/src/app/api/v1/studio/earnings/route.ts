import { EARNINGS_RULES } from "@delulu/core";
import { myEarnings } from "@delulu/db/runtime";
import { z } from "zod";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { earningsView } from "@/server/views";

const query = z.object({
  days: z
    .string()
    .regex(/^\d{1,4}$/)
    .transform(Number)
    .pipe(z.number().int().min(1))
    .optional(),
});

/**
 * GET /api/v1/studio/earnings?days=: the store's earnings for the last `days` days (default 7,
 * capped at 90) and the period before, in the store's time zone; staff orders apart.
 */
export const GET = route({ auth: "session", query }, async ({ session, query: q }) => {
  const earnings = await myEarnings(webPool(), {
    authSessionId: session.id,
    days: Math.min(q.days ?? EARNINGS_RULES.defaultDays, EARNINGS_RULES.maxDays),
  });
  return { json: earningsView(earnings) };
});
