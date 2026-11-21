import type { Metadata } from "next";
import type { ReactNode } from "react";

/** The Commerce Console. Rendered per request; the page itself decides, in the browser, whether the person may see it. */
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Not available", robots: { index: false } };

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return children;
}
