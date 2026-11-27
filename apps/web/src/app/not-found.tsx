import type { Metadata } from "next";
import { RecoveryScreen } from "./_components/recovery/RecoveryScreen";

export const metadata: Metadata = { title: "Page not found" };

/** Any address that has no page, and any shop, department or product that does not exist. */
export default function NotFound() {
  return (
    <RecoveryScreen
      title="We can't find that page"
      message="The address may be mistyped, or the page may have moved. Search for what you were after, or pick a department."
    />
  );
}
