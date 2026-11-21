import type { ReactNode } from "react";
import { ShopShell } from "../_components/ShopShell";

/**
 * The selling side. These pages are empty client shells: everything about the person (balance,
 * passport progress, shop) is loaded in the browser after the page renders, so the HTML is the same
 * for everyone.
 */
export const dynamic = "force-dynamic";

export default function SellLayout({ children }: { children: ReactNode }) {
  return <ShopShell>{children}</ShopShell>;
}
