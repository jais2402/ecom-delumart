"use client";

import { Button, CartIcon, cn, Icon, Text } from "@delulu/ui";
import { useId, useState } from "react";
import { trackClient } from "../_lib/analytics";
import { useCart } from "../_lib/cart-store";

interface Props {
  productId: string;
  name: string;
  available: boolean;
  /** Already in the person's collection (known on the product page; learned on a card when the server says so). */
  owned?: boolean;
  size?: "sm" | "md" | "lg";
  /**
   * "outline" is the quiet full-width button, "filled" the wide amber one of the product
   * page, "icon" the small square amber cart button of a product card (its text stays for screen readers).
   */
  appearance?: "outline" | "filled" | "icon";
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
  appearance = "outline",
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
    if (result.status === "added") {
      setAnnounce(`${name} added to your cart.`);
      trackClient("cart_add", { productId });
    } else if (result.status === "already") setAnnounce(`${name} is already in your cart.`);
    else if ("message" in result) {
      if (result.status === "owned") setOwnedHere(true);
      setMessage(result.message);
      setAnnounce(result.message);
    }
  }

  const icon = appearance === "icon";
  const look = {
    variant: appearance === "outline" ? ("secondary" as const) : ("cta" as const),
    size: icon ? ("md" as const) : size,
  };
  const shape = icon ? "min-w-touch px-0" : "w-full";
  const label = (text: string) => (icon ? <span className="sr-only">{text}</span> : text);
  const live = (
    <span role="status" aria-live="polite" className="sr-only">
      {announce}
    </span>
  );
  const nameHint = <span className="sr-only">: {name}</span>;
  const cartIcon = icon ? <Icon icon={CartIcon} size={18} /> : null;
  const wrap = icon ? cn("shrink-0", className) : className;

  if (owned || ownedHere) {
    return (
      <div className={wrap}>
        <Button variant="secondary" size={look.size} disabled className={shape}>
          {cartIcon}
          {label("In your collection")}
          {nameHint}
        </Button>
        {live}
      </div>
    );
  }
  if (!available) {
    return (
      <div className={wrap}>
        <Button variant="secondary" size={look.size} disabled aria-describedby={hintId} className={shape}>
          {cartIcon}
          {label("Add to cart")}
          {nameHint}
        </Button>
        <Text as="span" size="sm" muted id={hintId} className={icon ? "sr-only" : undefined}>
          Not available right now.
        </Text>
        {live}
      </div>
    );
  }
  if (inCart) {
    return (
      <div className={wrap}>
        <Button asChild variant="secondary" size={look.size} className={cn(shape, "motion-safe:animate-pop")}>
          <a href="/cart">
            {cartIcon}
            {label("In cart")}
            {nameHint}
            <span className="sr-only"> View cart</span>
          </a>
        </Button>
        {live}
      </div>
    );
  }
  return (
    <div className={wrap}>
      <Button
        variant={look.variant}
        size={look.size}
        loading={adding}
        onClick={() => void add()}
        {...(message ? { "aria-describedby": hintId } : {})}
        className={shape}
      >
        {!adding ? cartIcon : null}
        {label("Add to cart")}
        {nameHint}
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
