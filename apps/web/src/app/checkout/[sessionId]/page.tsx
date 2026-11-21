import type { Metadata } from "next";
import { CheckoutFlow } from "./CheckoutFlow";

export const metadata: Metadata = { title: "Checkout", robots: { index: false } };

/** Private: the page is an empty client shell; everything personal is loaded in the browser. */
export default async function CheckoutPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return <CheckoutFlow sessionId={sessionId} />;
}
