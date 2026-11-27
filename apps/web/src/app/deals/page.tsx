import type { Metadata } from "next";
import { DealsScreen } from "../_components/deals/DealsScreen";
import { ShopShell } from "../_components/ShopShell";

export const metadata: Metadata = {
  title: "Deals",
  description: "Products on sale and public shop coupons on DeluluMart.",
};

/** Public. Everything on it is read in the browser from routes that are already public. */
export default function Page() {
  return (
    <ShopShell>
      <DealsScreen />
    </ShopShell>
  );
}
