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
  const items = (await loadCatalog(found.slug)).map(toShopGridItem);

  return (
    <ShopShell>
      <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: found.name }]} />
      <Heading level={1} size="xl" className="mt-2">
        {found.name}
      </Heading>
      <Text muted className="mb-6 max-w-reading">
        {found.blurb}
      </Text>
      <CategoryBrowser items={items} />
    </ShopShell>
  );
}
