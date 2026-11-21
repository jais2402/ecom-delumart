import { api, type QuoteResponse, type Speed } from "./api";

/** Asks the server for a priced quote of one product at one delivery speed. */
export function requestQuote(
  productId: string,
  sellerId: string,
  speed: Speed,
  idempotencyKey: string,
): Promise<QuoteResponse> {
  return api<QuoteResponse>("/api/v1/checkout-sessions", {
    method: "POST",
    idempotencyKey,
    body: { lines: [{ productId }], speedBySeller: { [sellerId]: speed } },
  });
}
