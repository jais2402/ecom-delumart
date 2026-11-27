import type { Metadata } from "next";
import { PaymentsPanel } from "../../_components/account/PaymentsPanel";

export const metadata: Metadata = { title: "Payments", robots: { index: false } };

export default function Page() {
  return <PaymentsPanel />;
}
