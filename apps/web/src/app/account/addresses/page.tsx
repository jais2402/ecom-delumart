import type { Metadata } from "next";
import { AddressesPanel } from "../../_components/account/AddressesPanel";

export const metadata: Metadata = { title: "Addresses", robots: { index: false } };

export default function Page() {
  return <AddressesPanel />;
}
