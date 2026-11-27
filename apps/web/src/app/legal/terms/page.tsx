import type { Metadata } from "next";
import { PolicyPage } from "../../_components/legal/PolicyPage";
import { TERMS } from "../../_lib/legal-content";

export const metadata: Metadata = { title: "Terms of use (draft)" };

export default function Page() {
  return <PolicyPage doc={TERMS} />;
}
