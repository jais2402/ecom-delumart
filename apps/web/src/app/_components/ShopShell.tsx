"use client";

import { STARTING_GRANT_PAISE } from "@delulu/core";
import { ShopLayout, SiteFooter, SiteHeader } from "@delulu/ui";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

/** Client wrapper so the header search can navigate; pages stay server components. */
export function ShopShell({
  children,
  searchDefaultValue,
}: {
  children: ReactNode;
  searchDefaultValue?: string;
}) {
  const router = useRouter();
  return (
    <ShopLayout
      header={
        <SiteHeader
          balancePaise={STARTING_GRANT_PAISE}
          cartCount={0}
          onSearch={(query) => router.push(query ? `/search?q=${encodeURIComponent(query)}` : "/search")}
          {...(searchDefaultValue !== undefined ? { searchDefaultValue } : {})}
        />
      }
      footer={<SiteFooter />}
    >
      {children}
    </ShopLayout>
  );
}
