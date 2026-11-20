import { rupees } from "@delulu/core";
import {
  Breadcrumbs,
  Button,
  DeliveryOption,
  FictionLabel,
  Heading,
  PriceBlock,
  ProductArt,
  StockBadge,
  Text,
} from "@delulu/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SEED_PRODUCTS } from "../../../data/seed-catalog";
import { ShopShell } from "../../_components/ShopShell";
import { categoryName, storeNameOf } from "../../_lib/catalog";

export const dynamicParams = false;

export function generateStaticParams() {
  return SEED_PRODUCTS.map((product) => ({ id: product.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const product = SEED_PRODUCTS.find((entry) => entry.id === id);
  return { title: product ? product.name : "Product", ...(product ? { description: product.hook } : {}) };
}

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const product = SEED_PRODUCTS.find((entry) => entry.id === id);
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
          hue={product.templateHue}
          seed={product.name}
          alt={product.altText}
          className="rounded-lg"
        />
        <div className="flex flex-col gap-4">
          <Heading level={1} size="lg">
            {product.name}
          </Heading>
          <Text size="lg">{product.hook}</Text>
          <Text muted>{product.description}</Text>
          <div className="flex flex-wrap items-center gap-2">
            <StockBadge state="in-stock" />
            <Text as="span" size="sm" muted>
              Sold by {storeNameOf(product)}
            </Text>
          </div>
          <div className="flex flex-col gap-1">
            <PriceBlock amountPaise={rupees(product.priceRupees)} display="exact" />
            <FictionLabel>Fictional money</FictionLabel>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 font-display text-xl font-bold text-fg">Delivery options</legend>
            <DeliveryOption
              name="delivery"
              value="standard"
              defaultChecked
              speedName="Standard"
              arrival="Arrives in 24 hours"
              feePaise={rupees(1000)}
            />
            <DeliveryOption
              name="delivery"
              value="express"
              speedName="Express"
              arrival="Arrives in 2 hours"
              feePaise={rupees(10_000)}
            />
            {product.zapEligible ? (
              <DeliveryOption
                name="delivery"
                value="zap"
                speedName="Zap"
                arrival="Arrives in 10 minutes"
                feePaise={rupees(50_000)}
              />
            ) : null}
          </fieldset>

          <div className="flex flex-col gap-2">
            <Button disabled aria-describedby="add-to-cart-hint" size="lg">
              Add to cart
            </Button>
            <Text as="span" size="sm" muted id="add-to-cart-hint">
              Shopping opens when sign-in is connected
            </Text>
          </div>
        </div>
      </div>
    </ShopShell>
  );
}
