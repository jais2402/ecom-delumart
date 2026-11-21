import type { Metadata } from "next";
import { OrderPage } from "./OrderPage";

export const metadata: Metadata = { title: "Your order", robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OrderPage id={id} />;
}
