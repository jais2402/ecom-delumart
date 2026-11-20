import type { Metadata } from "next";
import { SEED_PRODUCTS } from "../../data/seed-catalog";
import { ShopShell } from "../_components/ShopShell";
import { SearchResults } from "./SearchResults";

export const metadata: Metadata = { title: "Search" };

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const { q } = await searchParams;
  const query = (Array.isArray(q) ? q[0] : q) ?? "";
  return (
    <ShopShell searchDefaultValue={query}>
      <SearchResults key={query} initialQuery={query} products={SEED_PRODUCTS} />
    </ShopShell>
  );
}
