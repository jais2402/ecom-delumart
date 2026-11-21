"use client";

import { Alert, Button } from "@delulu/ui";
import { useCart } from "../_lib/cart-store";

/** After the browser cart is merged into the account: what was left out and why. Dismissible. */
export function CartNotice() {
  const cart = useCart();
  const notice = cart.notice;
  if (!notice) return null;
  return (
    <Alert tone="warning" title="Some items were not added to your cart" className="mb-4">
      <ul className="list-disc pl-5">
        {notice.skipped.map((s) => (
          <li key={s.productId} className="break-words">
            {s.name}: {s.reason}.
          </li>
        ))}
      </ul>
      {notice.merged > 0 ? (
        <p className="mt-1">
          {notice.merged} {notice.merged === 1 ? "item was" : "items were"} added.
        </p>
      ) : null}
      <Button variant="secondary" size="sm" className="mt-2" onClick={cart.dismissNotice}>
        Dismiss
      </Button>
    </Alert>
  );
}
