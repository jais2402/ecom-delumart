import "./server-only";
import { cartWithPreview } from "@delulu/db/runtime";
import { z } from "zod";
import { SERVER_CONFIG } from "./config";
import { payPool } from "./db";
import { cartView } from "./views";

/** A delivery speed per seller key ("SEED" or a company id). */
export const speedBySellerSchema = z.record(
  z.string().min(1).max(64),
  z.enum(["STANDARD", "EXPRESS", "ZAP"]),
);

export const couponCodeSchema = z.string().min(1).max(64);

/**
 * The response of GET /api/v1/cart and of every cart change: the caller's cart grouped by seller
 * with its priced preview at the default options (STANDARD for every seller, no coupon), read in
 * one transaction as the checkout role, since the preview takes the checkout's own pricing path.
 */
export async function cartResponse(authSessionId: string) {
  const { cart, preview, previewError } = await cartWithPreview(payPool(), { authSessionId });
  return cartView(cart, preview, previewError?.code ?? null, SERVER_CONFIG.http.maxCartLines);
}
