import type { Metadata } from "next";
import { BankInboxPanel } from "../../_components/account/BankInboxPanel";

export const metadata: Metadata = { title: "Bank inbox", robots: { index: false } };

export default function Page() {
  return <BankInboxPanel />;
}
