import type { Metadata } from "next";
import { CollectionPanel } from "../../_components/account/CollectionPanel";

export const metadata: Metadata = { title: "Your collection", robots: { index: false } };

export default function Page() {
  return <CollectionPanel />;
}
