import type { Metadata } from "next";
import { ShopHome } from "../../_components/sell/ShopHome";

export const metadata: Metadata = { title: "Your shop", robots: { index: false } };

export default function Page() {
  return <ShopHome />;
}
