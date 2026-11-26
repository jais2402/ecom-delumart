"use client";

import { announcementText } from "@delulu/core";
import { Alert } from "@delulu/ui";
import { useEffect, useState } from "react";
import { type AnnouncementItem, formatWhen } from "../_lib/admin-actions";
import { loadAnnouncements } from "../_lib/announcements";

/**
 * In-app announcement of an economy change (PRD R7): a fee that changed for new orders. Public data
 * from GET /api/v1/announcements (the setting and the new value, no reason and no person). Shows
 * nothing when there is nothing to announce or the request fails.
 */
export function AnnouncementBanner() {
  const [items, setItems] = useState<AnnouncementItem[]>([]);
  useEffect(() => {
    let live = true;
    void loadAnnouncements().then((next) => {
      if (live) setItems(next);
    });
    return () => {
      live = false;
    };
  }, []);
  if (items.length === 0) return null;
  return (
    <Alert tone="info" title="Store news" className="mb-4">
      <ul aria-label="Changes for new orders" className="list-disc pl-5">
        {items.map((item) => (
          <li key={item.id} className="break-words">
            {announcementText(item.key, item.value)}{" "}
            <span className="text-fg-muted">From {formatWhen(item.effectiveFrom)}.</span>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-fg-muted">Orders you have already placed keep the price they were placed at.</p>
    </Alert>
  );
}
