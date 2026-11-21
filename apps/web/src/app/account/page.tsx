import type { Metadata } from "next";
import { OverviewPanel } from "../_components/account/OverviewPanel";

export const metadata: Metadata = { title: "Your account", robots: { index: false } };

export default function Page() {
  return <OverviewPanel />;
}
