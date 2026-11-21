import type { Metadata } from "next";
import { OrdersPanel } from "../../_components/account/OrdersPanel";

export const metadata: Metadata = { title: "Your orders", robots: { index: false } };

export default function Page() {
  return <OrdersPanel />;
}
