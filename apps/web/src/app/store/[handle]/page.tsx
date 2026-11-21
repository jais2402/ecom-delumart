import { DomainError } from "@delulu/core";
import { storeByHandle } from "@delulu/db/runtime";
import { Button, EmptyState, Heading, ProductGrid, ShopHeader } from "@delulu/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { webPool } from "@/server/db";
import { storeView } from "@/server/views";
import { ShopShell } from "../../_components/ShopShell";
import { toGridItem } from "../../_lib/catalog";
import { loadStoreProducts } from "../../_lib/catalog-server";

/**
 * Public: a shop's name, description and tier, the same for everyone. It reads only the store's
 * public face (no owner identity), never a session, and the HTML holds no balance or email; the
 * header's signed-in details arrive in the browser after the page renders.
 */
const HANDLE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

async function loadStore(raw: string) {
  const handle = raw.toLowerCase();
  if (handle.length > 24 || !HANDLE.test(handle)) return null;
  try {
    const store = await storeByHandle(webPool(), handle);
    return store === null ? null : storeView(store);
  } catch (error) {
    if (error instanceof DomainError) return null;
    throw error;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<Metadata> {
  const { handle } = await params;
  const store = await loadStore(handle);
  return store
    ? { title: store.displayName, ...(store.description ? { description: store.description } : {}) }
    : { title: "Shop not found" };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function StorePage({
  params,
  searchParams,
}: {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ cursor?: string | string[] }>;
}) {
  const { handle } = await params;
  const { cursor: rawCursor } = await searchParams;
  const store = await loadStore(handle);
  if (!store) notFound();
  const cursor = typeof rawCursor === "string" && UUID.test(rawCursor) ? rawCursor.toLowerCase() : null;
  const page = await loadStoreProducts(store.handle, cursor);

  return (
    <ShopShell>
      <div className="flex flex-col gap-6">
        <ShopHeader
          displayName={store.displayName}
          handle={store.handle}
          description={store.description}
          tier={store.tier}
        />
        <section aria-labelledby="shop-products" data-slot="shop-products" className="flex flex-col gap-3">
          <Heading level={2} size="md" id="shop-products">
            Products
          </Heading>
          {page.items.length === 0 && cursor === null ? (
            <EmptyState
              title="No products yet"
              description="This shop has not listed anything. Check back later."
              headingLevel={3}
            />
          ) : (
            <ProductGrid
              items={page.items.map(toGridItem)}
              label={`Products from ${store.displayName}`}
              headingLevel={3}
              emptyTitle="No more products"
              emptyDescription="That was the last page."
            />
          )}
          {cursor !== null || page.nextCursor !== null ? (
            <nav aria-label="Shop pages" className="flex flex-wrap gap-2">
              {cursor !== null ? (
                <Button asChild variant="secondary">
                  <a href={`/store/${store.handle}`}>First page</a>
                </Button>
              ) : null}
              {page.nextCursor !== null ? (
                <Button asChild variant="secondary">
                  <a href={`/store/${store.handle}?cursor=${page.nextCursor}`}>Next page</a>
                </Button>
              ) : null}
            </nav>
          ) : null}
        </section>
      </div>
    </ShopShell>
  );
}
