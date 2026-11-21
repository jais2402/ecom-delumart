"use client";

import { ShopLayout, SiteFooter } from "@delulu/ui";
import type { ReactNode } from "react";
import { CartNotice } from "./CartNotice";
import { SessionHeader } from "./SessionHeader";
import { PageViewTracker } from "./TrackEvent";

/** Client wrapper so the header can navigate and show the session; pages stay server components. */
export function ShopShell({
  children,
  searchDefaultValue,
}: {
  children: ReactNode;
  searchDefaultValue?: string;
}) {
  return (
    <ShopLayout
      header={<SessionHeader {...(searchDefaultValue !== undefined ? { searchDefaultValue } : {})} />}
      footer={<SiteFooter />}
    >
      <PageViewTracker surface="shop" />
      <CartNotice />
      {children}
    </ShopLayout>
  );
}
