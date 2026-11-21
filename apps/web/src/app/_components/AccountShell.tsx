"use client";

import { AccountLayout, SidebarNav, SiteFooter } from "@delulu/ui";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { refreshSession } from "../_lib/session-store";
import { useRequireAccount } from "../_lib/use-require-account";
import { ErrorBlock, LoadingBlock } from "./LoadState";
import { SessionHeader } from "./SessionHeader";

const ITEMS = [
  { label: "Overview", href: "/account" },
  { label: "Orders", href: "/account/orders" },
  { label: "Wallet", href: "/account/wallet" },
  { label: "Cards", href: "/account/cards" },
  { label: "Collection", href: "/account/collection" },
  { label: "Profile", href: "/account/profile" },
] as const;

/** Account frame: header, sidebar and a guard that sends signed-out visitors to /sign-in. */
export function AccountShell({ children }: { children: ReactNode }) {
  const pathname = usePathname().replace(/(.)\/$/, "$1");
  const { session, ok } = useRequireAccount();
  return (
    <AccountLayout
      header={<SessionHeader />}
      footer={<SiteFooter />}
      sidebar={<SidebarNav label="Account" items={ITEMS} currentHref={pathname} />}
    >
      {ok ? (
        children
      ) : session.status === "error" ? (
        <ErrorBlock message={session.message} onRetry={() => void refreshSession()} />
      ) : (
        <LoadingBlock label="Checking your sign-in" />
      )}
    </AccountLayout>
  );
}
