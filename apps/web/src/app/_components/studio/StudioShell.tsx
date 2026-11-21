"use client";

import { Badge, PortalLayout, SidebarNav } from "@delulu/ui";
import { usePathname, useRouter } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect } from "react";
import type { CompanyView } from "../../_lib/selling";
import { useApiGet } from "../../_lib/use-api";
import { useRequireAccount } from "../../_lib/use-require-account";
import { ErrorBlock, LoadingBlock } from "../LoadState";

const SECTIONS = ["overview", "orders", "earnings", "inventory", "coupons", "appeals"] as const;

/** The sidebar entry for a path; the listing editor (/studio/new, /studio/<id>) belongs to Products. */
export function currentHref(pathname: string): string {
  const segment = pathname.replace(/\/+$/, "").split("/")[2];
  const section = SECTIONS.find((s) => s === segment);
  return section ? `/studio/${section}` : "/studio/products";
}

const StudioContext = createContext<CompanyView | null>(null);

/** The signed-in person's shop, available to every studio screen. */
export function useStudioCompany(): CompanyView {
  const company = useContext(StudioContext);
  if (!company) throw new Error("useStudioCompany must be used inside StudioShell");
  return company;
}

/**
 * The Partner Portal frame. Only the owner of a shop gets past it; everyone else goes back to
 * /sell. The label and the "portal mode" badge say plainly that this is not the shop.
 */
export function StudioShell({ children }: { children: ReactNode }) {
  const { ok } = useRequireAccount();
  const router = useRouter();
  const pathname = usePathname();
  const loaded = useApiGet<{ company: CompanyView | null }>(ok ? "/api/v1/company" : null);
  const company = loaded.status === "ready" ? loaded.data.company : null;

  useEffect(() => {
    if (loaded.status === "ready" && loaded.data.company === null) router.replace("/sell");
  }, [loaded, router]);

  const current = currentHref(pathname);
  const nav = (
    <SidebarNav
      label="Partner Portal"
      currentHref={current}
      items={[
        { label: "Overview", href: "/studio/overview" },
        { label: "Products", href: "/studio/products" },
        { label: "Orders", href: "/studio/orders" },
        { label: "Earnings", href: "/studio/earnings" },
        { label: "Inventory", href: "/studio/inventory" },
        { label: "Coupons", href: "/studio/coupons" },
        { label: "Appeals", href: "/studio/appeals" },
        { label: "Back to the shop", href: "/" },
      ]}
    />
  );
  const topBar = (
    <>
      <Badge tone="highlight">You are in the portal, not the shop</Badge>
      {company ? <span className="text-sm text-fg-muted">{company.displayName}</span> : null}
    </>
  );

  return (
    <PortalLayout nav={nav} topBar={topBar}>
      {!ok || loaded.status === "loading" || (loaded.status === "ready" && !company) ? (
        <LoadingBlock rows={3} label="Opening your portal" />
      ) : loaded.status === "error" ? (
        <ErrorBlock message={loaded.message} onRetry={loaded.reload} />
      ) : company ? (
        <StudioContext.Provider value={company}>{children}</StudioContext.Provider>
      ) : null}
    </PortalLayout>
  );
}
