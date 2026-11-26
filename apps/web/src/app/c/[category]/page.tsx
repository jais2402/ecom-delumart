import { Breadcrumbs, Heading, Text } from "@delulu/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CATEGORIES } from "../../../data/seed-catalog";
import { ShopShell } from "../../_components/ShopShell";
import { toShopGridItem } from "../../_components/shop-items";
import { loadCatalog } from "../../_lib/catalog-server";
import { CategoryBrowser } from "./CategoryBrowser";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ category: string }>;
}): Promise<Metadata> {
  const { category } = await params;
  const found = CATEGORIES.find((entry) => entry.slug === category);
  return { title: found ? found.name : "Category" };
}

export default async function CategoryPage({ params }: { params: Promise<{ category: string }> }) {
  const { category } = await params;
  const found = CATEGORIES.find((entry) => entry.slug === category);
  if (!found) notFound();
  const products = await loadCatalog(found.slug);
  const items = products.map(toShopGridItem);
  const sellers = Object.fromEntries(
    products.flatMap((p) => (p.sellerKey && p.sellerKey !== "SEED" ? [[p.id, p.sellerKey]] : [])),
  );

  return (
    <ShopShell>
      <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: found.name }]} />
      <header className="mt-2 mb-6 rounded-lg bg-surface p-5 md:p-6">
        <Heading level={1} size="xl">
          {found.name}
        </Heading>
        <Text muted className="mt-1 max-w-reading">
          {found.blurb}
        </Text>
        <Text size="sm" muted className="mt-2">
          {items.length} {items.length === 1 ? "product" : "products"}
        </Text>
      </header>
      <CategoryBrowser items={items} sellers={sellers} />
    </ShopShell>
  );
}
