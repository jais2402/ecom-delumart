import type { Metadata } from "next";
import { OrderPage } from "./OrderPage";

export const metadata: Metadata = { title: "Your order", robots: { index: false } };

/** Private: rendered per request and sent `Cache-Control: private, no-store` (src/proxy.ts). */
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OrderPage id={id} />;
}
