import {
  Breadcrumbs,
  Button,
  EmptyState,
  FictionLabel,
  Heading,
  PriceBlock,
  ProductArt,
  Text,
} from "@delulu/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BuyPanel } from "../../_components/BuyPanel";
import { ShopShell } from "../../_components/ShopShell";
import { ProductSafetyActions } from "../../_components/safety/ProductSafetyActions";
import { TrackEvent } from "../../_components/TrackEvent";
import { categoryName, storeNameOf } from "../../_lib/catalog";
import { loadProduct, loadProductPage } from "../../_lib/catalog-server";
import { parsePaise } from "../../_lib/money";

/** Public. Ownership and balance are added in the browser by BuyPanel. */
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
  const page = await loadProductPage(id);
  if (!page) notFound();
  if (page.status === "UNAVAILABLE") {
    return (
      <ShopShell>
        <div className="mx-auto flex max-w-reading flex-col items-center gap-4 py-8 text-center">
          <EmptyState
            title="No longer available"
            description="This product is not on sale any more. Anyone who already bought it keeps it."
            headingLevel={1}
            action={
              <Button asChild>
                <a href="/">Keep shopping</a>
              </Button>
            }
          />
        </div>
      </ShopShell>
    );
  }
  const product = page.product;

  return (
    <ShopShell>
      <TrackEvent name="product_view" props={{ productId: product.id }} />
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
            Sold by{" "}
            {product.storeHandle ? (
              <a
                className="inline-flex min-h-touch items-center text-action underline"
                href={`/store/${product.storeHandle}`}
              >
                {storeNameOf(product)}
              </a>
            ) : (
              storeNameOf(product)
            )}
          </Text>
          <div className="flex flex-col gap-1">
            <PriceBlock
              amountPaise={parsePaise(product.pricePaise)}
              {...(product.referencePricePaise
                ? { referenceAmountPaise: parsePaise(product.referencePricePaise), saleLabel: "On sale" }
                : {})}
              display="exact"
            />
            <FictionLabel>Fictional money</FictionLabel>
          </div>
          <BuyPanel product={product} />
          <ProductSafetyActions
            productId={product.id}
            productName={product.name}
            companyId={product.sellerKey && product.sellerKey !== "SEED" ? product.sellerKey : null}
            shopName={storeNameOf(product)}
          />
        </div>
      </div>
    </ShopShell>
  );
}
