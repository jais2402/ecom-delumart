import type { Metadata } from "next";
import { PolicyPage } from "../../_components/legal/PolicyPage";
import { PRIVACY } from "../../_lib/legal-content";

export const metadata: Metadata = { title: "Privacy notice (draft)" };

export default function Page() {
  return <PolicyPage doc={PRIVACY} />;
}
