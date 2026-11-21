import type { Metadata } from "next";
import { ProfilePanel } from "../../_components/account/ProfilePanel";

export const metadata: Metadata = { title: "Profile", robots: { index: false } };

export default function Page() {
  return <ProfilePanel />;
}
