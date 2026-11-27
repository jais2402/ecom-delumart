"use client";

import { RecoveryPanel } from "@delulu/ui";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { CATEGORY_LINKS } from "../../_lib/category-style";
import { ShopShell } from "../ShopShell";

/**
 * The storefront's page for "not found", "no longer available" and "something went wrong": the
 * shop header and footer around one calm panel with search, the departments and a way home. Every
 * such page uses it so they read alike.
 */
export function RecoveryScreen({
  title,
  message,
  detail,
  action,
}: {
  title: string;
  message: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
}) {
  const router = useRouter();
  return (
    <ShopShell>
      <RecoveryPanel
        title={title}
        message={message}
        {...(detail ? { detail } : {})}
        {...(action ? { action } : {})}
        searchAction="/search"
        onSearch={(query) => router.push(query ? `/search?q=${encodeURIComponent(query)}` : "/search")}
        categories={CATEGORY_LINKS}
      />
    </ShopShell>
  );
}
