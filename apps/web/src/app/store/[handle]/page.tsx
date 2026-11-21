import { DomainError } from "@delulu/core";
import { storeByHandle } from "@delulu/db/runtime";
import { EmptyState, Heading, ShopHeader } from "@delulu/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { webPool } from "@/server/db";
import { storeView } from "@/server/views";
import { ShopShell } from "../../_components/ShopShell";

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

export default async function StorePage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const store = await loadStore(handle);
  if (!store) notFound();

  return (
    <ShopShell>
      <div className="flex flex-col gap-6">
        <ShopHeader
          displayName={store.displayName}
          handle={store.handle}
          description={store.description}
          tier={store.tier}
        />
        {/* SLOT: the shop's product grid goes here once listings exist (a later step). */}
        <section aria-labelledby="shop-products" data-slot="shop-products" className="flex flex-col gap-3">
          <Heading level={2} size="md" id="shop-products">
            Products
          </Heading>
          <EmptyState
            title="No products yet"
            description="This shop has not listed anything. Check back later."
            headingLevel={3}
          />
        </section>
      </div>
    </ShopShell>
  );
}
