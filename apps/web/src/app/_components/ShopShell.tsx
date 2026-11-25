"use client";

import { ShopLayout } from "@delulu/ui";
import type { ReactNode } from "react";
import { CartNotice } from "./CartNotice";
import { SessionHeader } from "./SessionHeader";
import { ShopFooter } from "./ShopFooter";
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
      footer={<ShopFooter />}
    >
      <PageViewTracker surface="shop" />
      <CartNotice />
      {children}
    </ShopLayout>
  );
}
