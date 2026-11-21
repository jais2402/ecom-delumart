import { Breadcrumbs, FictionLabel, Heading, PriceBlock, ProductArt, Text } from "@delulu/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BuyPanel } from "../../_components/BuyPanel";
import { ShopShell } from "../../_components/ShopShell";
import { categoryName, storeNameOf } from "../../_lib/catalog";
import { loadProduct } from "../../_lib/catalog-server";
import { parsePaise } from "../../_lib/money";

/** Public and cacheable. Ownership and balance are added in the browser by BuyPanel. */
export const revalidate = 60;

/** No pages are built ahead (there is no database at build time); each is cached on first visit. */
export function generateStaticParams() {
  return [];
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const product = await loadProduct(id);
  return {
    title: product ? product.name : "Product",
    ...(product?.hook ? { description: product.hook } : {}),
  };
}

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const product = await loadProduct(id);
  if (!product) notFound();

  return (
    <ShopShell>
      <Breadcrumbs
        items={[
          { label: "Home", href: "/" },
          { label: categoryName(product.category), href: `/c/${product.category}` },
          { label: product.name },
        ]}
      />
      <div className="mt-4 grid items-start gap-6 md:grid-cols-2">
        <ProductArt
          hue={product.templateId}
          seed={product.name}
          alt={product.altText}
          className="rounded-lg"
        />
        <div className="flex flex-col gap-4">
          <Heading level={1} size="lg">
            {product.name}
          </Heading>
          {product.hook ? <Text size="lg">{product.hook}</Text> : null}
          <Text muted>{product.description}</Text>
          <Text as="span" size="sm" muted>
            Sold by {storeNameOf(product)}
          </Text>
          <div className="flex flex-col gap-1">
            <PriceBlock amountPaise={parsePaise(product.pricePaise)} display="exact" />
            <FictionLabel>Fictional money</FictionLabel>
          </div>
          <BuyPanel product={product} />
        </div>
      </div>
    </ShopShell>
  );
}
