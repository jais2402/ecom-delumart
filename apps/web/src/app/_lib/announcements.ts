import type { AnnouncementItem } from "./admin-actions";
import { api } from "./api";

/**
 * The storefront banner's data: the economy changes announced lately (GET /api/v1/announcements,
 * public, no session). Kept for a minute in memory so moving between pages does not refetch; a
 * failure shows no banner (it is news, never a blocker).
 */
const TTL_MS = 60_000;
let cached: { at: number; items: AnnouncementItem[] } | null = null;

export async function loadAnnouncements(now: () => number = Date.now): Promise<AnnouncementItem[]> {
  if (cached !== null && now() - cached.at < TTL_MS) return cached.items;
  try {
    const { items } = await api<{ items: AnnouncementItem[] }>("/api/v1/announcements");
    cached = { at: now(), items };
    return items;
  } catch {
    return [];
  }
}

/** Test seam: forget the cached answer. */
export function resetAnnouncementsForTests(): void {
  cached = null;
}
