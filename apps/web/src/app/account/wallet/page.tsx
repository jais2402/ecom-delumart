import type { Metadata } from "next";
import { WalletPanel } from "../../_components/account/WalletPanel";

export const metadata: Metadata = { title: "Wallet", robots: { index: false } };

export default function Page() {
  return <WalletPanel />;
}
