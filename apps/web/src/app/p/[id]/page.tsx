import { Breadcrumbs, Button, EmptyState, Heading, ProductPicture, Text } from "@delulu/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BuyPanel } from "../../_components/BuyPanel";
import { RecentlyViewedRail, RecentlyViewedRecorder } from "../../_components/RecentlyViewed";
import { ProductReviews } from "../../_components/reviews/ProductReviews";
import { ShopShell } from "../../_components/ShopShell";
import { ProductSafetyActions } from "../../_components/safety/ProductSafetyActions";
import { TrackEvent } from "../../_components/TrackEvent";
import { categoryName, storeNameOf } from "../../_lib/catalog";
import { loadProduct, loadProductPage } from "../../_lib/catalog-server";
import { motifOfCategory } from "../../_lib/category-style";
import { photoSrcOf } from "../../_lib/product-photos";

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
      <RecentlyViewedRecorder productId={product.id} />
      <Breadcrumbs
        items={[
          { label: "Home", href: "/" },
          { label: categoryName(product.category), href: `/c/${product.category}` },
          { label: product.name },
        ]}
      />
      <div className="mt-6 grid items-start gap-4 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] md:gap-6">
        <div className="flex flex-col gap-8 rounded-lg bg-surface p-5 md:p-6">
          <ProductPicture
            imageSrc={photoSrcOf(product)}
            hue={product.templateId}
            seed={product.name}
            motif={motifOfCategory(product.category)}
            alt={product.altText}
            eager
          />
          <section
            aria-labelledby="description"
            className="hidden flex-col gap-3 border-t border-border pt-8 md:flex"
          >
            <Heading level={2} size="md" id="description" className="text-2xl">
              Description
            </Heading>
            <Text muted>{product.description}</Text>
          </section>
        </div>
        <div className="flex flex-col gap-6 rounded-lg bg-surface p-5 md:p-6">
          <div className="flex flex-col gap-2">
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
            <Heading level={1} size="lg" className="text-2xl font-semibold md:text-3xl">
              {product.name}
            </Heading>
            {product.hook ? <Text muted>{product.hook}</Text> : null}
            {/* Room for a rating summary (stars and review count) once ratings exist. Nothing is drawn now. */}
          </div>
          <BuyPanel product={product} />
          <section
            aria-labelledby="description-mobile"
            className="flex flex-col gap-3 border-t border-border pt-6 md:hidden"
          >
            <Heading level={2} size="md" id="description-mobile" className="text-2xl">
              Description
            </Heading>
            <Text muted>{product.description}</Text>
          </section>
          <ProductSafetyActions
            productId={product.id}
            productName={product.name}
            companyId={product.sellerKey && product.sellerKey !== "SEED" ? product.sellerKey : null}
            shopName={storeNameOf(product)}
          />
        </div>
      </div>
      {/* Ratings and reviews (decisions.md #14): self-contained, below the description */}
      <div className="mt-4 md:mt-6">
        <ProductReviews productId={product.id} />
      </div>
      <RecentlyViewedRail excludeId={product.id} className="mt-6 md:mt-8" />
    </ShopShell>
  );
}
