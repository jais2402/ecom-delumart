import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import type { ReactNode } from "react";
import { CartSync } from "./_components/CartSync";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const display = Space_Grotesk({ subsets: ["latin"], variable: "--font-space-grotesk", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains-mono", display: "swap" });

/**
 * Every page is rendered per request: the Content-Security-Policy nonce (src/proxy.ts) is new for
 * each response, and Next.js can put it on its scripts only while rendering. Public data stays
 * cacheable at the API (/api/v1/catalog, /api/v1/products).
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "DeluluMart", template: "%s · DeluluMart" },
  description: "Start with ₹100 crore of fictional money. Buy things that don't exist.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${display.variable} ${mono.variable}`}>
      <body>
        <CartSync />
        {children}
      </body>
    </html>
  );
}
