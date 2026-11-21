"use client";

import { Heading, type ListingFormValues, ProductCard, parseQuantity, parseRupees, Text } from "@delulu/ui";

/** The product card exactly as shoppers will see it, drawn from what is in the form right now. */
export function ListingPreview({ values, storeName }: { values: ListingFormValues; storeName: string }) {
  const rupees = parseRupees(values.priceRupees);
  const quantity = parseQuantity(values.quantity);
  return (
    <section aria-labelledby="preview-heading" className="flex flex-col gap-2">
      <Heading level={2} size="sm" id="preview-heading">
        Preview
      </Heading>
      <Text size="sm" muted>
        This is how shoppers will see your product.
      </Text>
      {/* inert: a picture of the card, not a working link */}
      <div inert data-testid="listing-preview">
        <ProductCard
          href="#preview"
          name={values.name.trim() || "Your product name"}
          hook={values.hook.trim()}
          hue={values.templateId}
          imageAlt={values.altText.trim()}
          pricePaise={(rupees ?? 0n) * 100n}
          storeName={storeName}
          stock={
            values.inventoryMode === "EXCLUSIVE"
              ? { state: "edition", number: 0, of: quantity ?? 0 }
              : { state: "in-stock" }
          }
          headingLevel={3}
        />
      </div>
    </section>
  );
}
