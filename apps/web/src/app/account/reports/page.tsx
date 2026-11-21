import type { Metadata } from "next";
import { ReportsPanel } from "../../_components/account/ReportsPanel";

export const metadata: Metadata = { title: "Your reports", robots: { index: false } };

export default function Page() {
  return <ReportsPanel />;
}
