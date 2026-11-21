import type { Metadata } from "next";
import { SellPanel } from "../_components/sell/SellPanel";

export const metadata: Metadata = {
  title: "Sell on DeluluMart",
  description:
    "Open a creator studio on DeluluMart: spend down your fictional balance or earn the Inventor Passport.",
};

export default function Page() {
  return <SellPanel />;
}
