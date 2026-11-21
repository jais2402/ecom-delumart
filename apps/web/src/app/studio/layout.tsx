import type { Metadata } from "next";
import type { ReactNode } from "react";
import { StudioShell } from "../_components/studio/StudioShell";

/**
 * The Partner Portal. Every page is an empty client shell: the shop, its listings and its
 * numbers are loaded in the browser for the signed-in owner, so the HTML is the same for everyone.
 */
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Partner Portal", robots: { index: false } };

export default function StudioLayout({ children }: { children: ReactNode }) {
  return <StudioShell>{children}</StudioShell>;
}
