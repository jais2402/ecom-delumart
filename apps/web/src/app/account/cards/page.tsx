import type { Metadata } from "next";
import { CardsPanel } from "../../_components/account/CardsPanel";

export const metadata: Metadata = { title: "Cards", robots: { index: false } };

export default function Page() {
  return <CardsPanel />;
}
