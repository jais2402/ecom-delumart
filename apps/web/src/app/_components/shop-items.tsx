import type { ProductGridItem } from "@delulu/ui";
import type { ProductResponse } from "../_lib/api";
import { toGridItem } from "../_lib/catalog";
import { AddToCartButton } from "./AddToCartButton";
import { SaveToggle } from "./SaveToggle";

/** A catalog card with its full-width "Add to cart" button under the price and the save heart on the picture's corner. */
export function toShopGridItem(product: ProductResponse): ProductGridItem {
  return {
    ...toGridItem(product),
    actions: (
      <AddToCartButton
        productId={product.id}
        name={product.name}
        available={product.available}
        appearance="filled"
        size="md"
        quietHint
      />
    ),
    overlay: <SaveToggle productId={product.id} name={product.name} round />,
  };
}
