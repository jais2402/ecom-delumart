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
      <>
        <AddToCartButton
          productId={product.id}
          name={product.name}
          available={product.available}
          appearance="icon"
        />
        <SaveToggle productId={product.id} name={product.name} />
      </>
    ),
  };
}
