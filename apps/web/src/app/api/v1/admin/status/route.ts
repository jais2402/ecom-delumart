import { adminStatus } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { adminStatusView } from "@/server/views";

/**
 * GET /api/v1/admin/status: the console's status — the publication switch, listings overdue for
 * review (count and the oldest one's age), open report cases and open appeals (Super Admin only;
 * 403 for anyone else, as on every admin route).
 */
export const GET = route(
  { auth: "session", rateLimits: [{ rule: RATE_RULES.adminActor }] },
  async ({ session }) => {
    const status = await adminStatus(webPool(), { authSessionId: session.id });
    return { json: adminStatusView(status) };
  },
);
