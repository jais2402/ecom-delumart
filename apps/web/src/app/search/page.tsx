import type { Metadata } from "next";
import { Suspense } from "react";
import { ShopShell } from "../_components/ShopShell";
import { loadCatalog } from "../_lib/catalog-server";
import { SearchResults } from "./SearchResults";

export const metadata: Metadata = { title: "Search" };

/** Public: the query is read in the browser, so the HTML is the same for everyone. */
export default async function SearchPage() {
  const products = await loadCatalog();
  return (
    <ShopShell>
      <Suspense fallback={null}>
        <SearchResults products={products} />
      </Suspense>
    </ShopShell>
  );
}
