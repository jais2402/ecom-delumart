import type { Metadata } from "next";
import { PolicyPage } from "../../_components/legal/PolicyPage";
import { RESEARCH } from "../../_lib/legal-content";

export const metadata: Metadata = { title: "Research use (draft)" };

export default function Page() {
  return <PolicyPage doc={RESEARCH} />;
}
