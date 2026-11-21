import type { ProductGridItem } from "@delulu/ui";
import type { ProductResponse } from "../_lib/api";
import { toGridItem } from "../_lib/catalog";
import { AddToCartButton } from "./AddToCartButton";
import { SaveToggle } from "./SaveToggle";

/** A catalog card with its "Add to cart" button and save heart. */
export function toShopGridItem(product: ProductResponse): ProductGridItem {
  return {
    ...toGridItem(product),
    actions: (
      <div className="flex items-start gap-2">
        <AddToCartButton
          productId={product.id}
          name={product.name}
          available={product.available}
          size="md"
          className="min-w-0 flex-1"
        />
        <SaveToggle productId={product.id} name={product.name} />
      </div>
    ),
  };
}
