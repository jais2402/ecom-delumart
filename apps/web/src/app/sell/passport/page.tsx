import type { Metadata } from "next";
import { PassportPanel } from "../../_components/sell/PassportPanel";

export const metadata: Metadata = { title: "Inventor Passport", robots: { index: false } };

export default function Page() {
  return <PassportPanel />;
}
