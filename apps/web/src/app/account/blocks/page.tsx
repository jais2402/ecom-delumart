import type { Metadata } from "next";
import { BlocksPanel } from "../../_components/account/BlocksPanel";

export const metadata: Metadata = { title: "Blocked shops", robots: { index: false } };

export default function Page() {
  return <BlocksPanel />;
}
