"use client";

import { Button, Text } from "@delulu/ui";
import { useId, useState } from "react";
import { useCart } from "../_lib/cart-store";

interface Props {
  productId: string;
  name: string;
  available: boolean;
  /** Already in the person's collection (known on the product page; learned on a card when the server says so). */
  owned?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}

/**
 * Add to cart for one product, in the local cart when signed out and the account cart when signed
 * in. The visible text stays short; the product's name is read out after it so several buttons on
 * a page stay distinguishable. The result is announced politely.
 */
export function AddToCartButton({
  productId,
  name,
  available,
  owned = false,
  size = "lg",
  className,
}: Props) {
  const cart = useCart();
  const hintId = useId();
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [ownedHere, setOwnedHere] = useState(false);
  const inCart = cart.ids.includes(productId.toLowerCase());

  async function add() {
    setAdding(true);
    setMessage(null);
    const result = await cart.add(productId);
    setAdding(false);
    if (result.status === "added") setAnnounce(`${name} added to your cart.`);
    else if (result.status === "already") setAnnounce(`${name} is already in your cart.`);
    else if ("message" in result) {
      if (result.status === "owned") setOwnedHere(true);
      setMessage(result.message);
      setAnnounce(result.message);
    }
  }

  const live = (
    <span role="status" aria-live="polite" className="sr-only">
      {announce}
    </span>
  );
  const nameHint = <span className="sr-only">: {name}</span>;

  if (owned || ownedHere) {
    return (
      <div className={className}>
        <Button variant="secondary" size={size} disabled className="w-full">
          In your collection{nameHint}
        </Button>
        {live}
      </div>
    );
  }
  if (!available) {
    return (
      <div className={className}>
        <Button variant="secondary" size={size} disabled aria-describedby={hintId} className="w-full">
          Add to cart{nameHint}
        </Button>
        <Text as="span" size="sm" muted id={hintId}>
          Not available right now.
        </Text>
        {live}
      </div>
    );
  }
  if (inCart) {
    return (
      <div className={className}>
        <Button asChild variant="secondary" size={size} className="w-full">
          <a href="/cart">
            In cart{nameHint}
            <span className="sr-only"> View cart</span>
          </a>
        </Button>
        {live}
      </div>
    );
  }
  return (
    <div className={className}>
      <Button
        variant="secondary"
        size={size}
        loading={adding}
        onClick={() => void add()}
        {...(message ? { "aria-describedby": hintId } : {})}
        className="w-full"
      >
        Add to cart{nameHint}
      </Button>
      {message ? (
        <p id={hintId} className="mt-1 text-sm font-medium text-danger">
          {message}
        </p>
      ) : null}
      {live}
    </div>
  );
}
