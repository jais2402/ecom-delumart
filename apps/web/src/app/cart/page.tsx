import type { Metadata } from "next";
import { ShopShell } from "../_components/ShopShell";
import { CartScreen } from "./CartScreen";

export const metadata: Metadata = { title: "Your cart", robots: { index: false } };

/** Private: the cart is read in the browser (the account cart, or the ids kept on this device). */
export default function Page() {
  return (
    <ShopShell>
      <CartScreen />
    </ShopShell>
  );
}
