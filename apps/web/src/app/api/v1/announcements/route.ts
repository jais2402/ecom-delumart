import { publicAnnouncements } from "@delulu/db/runtime";
import { announcementView } from "@/server/admin-actions";
import { webPool } from "@/server/db";
import { PUBLIC_SHORT_CACHE, route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";

/**
 * GET /api/v1/announcements: the economy changes announced lately (a fee or delivery fee that
 * changed for new orders), newest first, for the storefront banner. Public and briefly cacheable
 * (30 s); never reads the session; names the setting and the new value only (no reason, no person,
 * no old value). Limited per client address.
 */
export const GET = route(
  { auth: "public", publicCache: PUBLIC_SHORT_CACHE, rateLimits: [{ rule: RATE_RULES.announcementAddress }] },
  async () => {
    const items = await publicAnnouncements(webPool());
    return { json: { items: items.map(announcementView) } };
  },
);
