"use client";

import { useEffect } from "react";
import { hydrateCart, syncCartWithSession } from "../_lib/cart-store";
import { useSession } from "../_lib/session-store";

/**
 * Mounted once in the root layout. Reads the signed-out cart after hydration and, whenever the
 * session changes, picks the cart's source of truth and merges the browser cart into the account
 * once the person has finished signing in.
 */
export function CartSync() {
  const session = useSession();
  useEffect(() => {
    hydrateCart();
  }, []);
  useEffect(() => {
    syncCartWithSession(session);
  }, [session]);
  return null;
}
