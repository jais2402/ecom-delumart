import type { Metadata } from "next";
import { SavedPanel } from "../../_components/account/SavedPanel";

export const metadata: Metadata = { title: "Saved products", robots: { index: false } };

export default function Page() {
  return <SavedPanel />;
}
