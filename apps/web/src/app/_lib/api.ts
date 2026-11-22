/**
 * The browser's only way to talk to /api/v1: same-origin fetch, the double-submit CSRF token,
 * one Idempotency-Key per user intent, and bounded retries. Nothing here writes to browser
 * storage, the URL or the console; tokens, PINs and codes live only in memory for the request.
 */

export class ApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    retryable: boolean,
    status: number,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.details = details;
  }
}

export const RETRY = { max: 3, baseMs: 250, jitterMs: 150 } as const;

export interface ApiRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** One key per user intent; the same key is reused on every retry. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

type Sleep = (ms: number) => Promise<void>;
let sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Test seam: replace the backoff timer. */
export function setSleepForTests(fn: Sleep | null): void {
  sleep = fn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

let csrfToken: Promise<string> | null = null;

/** Drop the cached token (after sign-in or sign-out the cookie may have changed). */
export function resetCsrf(): void {
  csrfToken = null;
}

async function loadCsrf(): Promise<string> {
  const response = await fetch("/api/v1/auth/csrf", { credentials: "same-origin", cache: "no-store" });
  if (!response.ok)
    throw new ApiError("INTERNAL", "Could not start a secure request.", true, response.status);
  const json = (await response.json()) as { csrfToken?: unknown };
  if (typeof json.csrfToken !== "string") throw new ApiError("INTERNAL", "Unexpected response.", false, 500);
  return json.csrfToken;
}

function csrf(): Promise<string> {
  csrfToken ??= loadCsrf().catch((error: unknown) => {
    csrfToken = null;
    throw error;
  });
  return csrfToken;
}

/** A fresh key for a new user intent. Reuse the same value when retrying that intent. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

function backoff(attempt: number): number {
  return RETRY.baseMs * 2 ** attempt + Math.floor(Math.random() * RETRY.jitterMs);
}

async function toError(response: Response): Promise<ApiError> {
  let code = "INTERNAL";
  let message = "Something went wrong. Try again.";
  let retryable = false;
  let details: Record<string, unknown> = {};
  try {
    const json = (await response.json()) as {
      error?: { code?: string; message?: string; retryable?: boolean; details?: Record<string, unknown> };
    };
    if (json.error) {
      code = json.error.code ?? code;
      message = json.error.message ?? message;
      retryable = json.error.retryable === true;
      details = json.error.details ?? {};
    }
  } catch {
    // not JSON: keep the generic error
  }
  return new ApiError(code, message, retryable, response.status, details);
}

export async function api<T>(path: string, request: ApiRequest = {}): Promise<T> {
  const method = request.method ?? "GET";
  const unsafe = method !== "GET";
  // A network failure on a write may have reached the server; only replay it when a key makes that safe.
  const retryNetwork = !unsafe || request.idempotencyKey !== undefined;
  let csrfRetried = false;

  for (let attempt = 0; ; attempt++) {
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (unsafe) headers["x-csrf-token"] = await csrf();
      if (request.body !== undefined) headers["content-type"] = "application/json";
      if (request.idempotencyKey) headers["idempotency-key"] = request.idempotencyKey;
      const init: RequestInit = { method, credentials: "same-origin", headers, cache: "no-store" };
      if (request.body !== undefined) init.body = JSON.stringify(request.body);
      if (request.signal) init.signal = request.signal;

      const response = await fetch(path, init);
      if (response.ok) return (await response.json()) as T;

      const error = await toError(response);
      if (error.code === "FORBIDDEN" && unsafe && !csrfRetried) {
        csrfRetried = true;
        resetCsrf();
        attempt--;
        continue;
      }
      throw error;
    } catch (error) {
      if (error instanceof ApiError) {
        if (!error.retryable || attempt >= RETRY.max) throw error;
      } else if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      } else {
        // fetch rejected: the network failed
        if (!retryNetwork || attempt >= RETRY.max) {
          throw new ApiError(
            "NETWORK",
            "Could not reach DeluluMart. Check your connection and try again.",
            true,
            0,
          );
        }
      }
      await sleep(backoff(attempt));
    }
  }
}

/** Friendly text for any thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "Something went wrong. Try again.";
}

/** Types of the API bodies the screens read (money fields are decimal strings). */
export interface MeResponse {
  onboarding: {
    hasProfile: boolean;
    /** True only for a number confirmed by text message. */
    phoneVerified: boolean;
    /** The phone step is done (in 'unverified' mode without a text message). */
    phoneRecorded?: boolean;
    /** The account's number was released to its confirmed owner: a number is needed again. */
    phoneReverifyRequired?: boolean;
    hasBirthdate: boolean;
    isAdult: boolean;
    provisioned: boolean;
    pinSet: boolean;
  };
  profile: { handle: string } | null;
  account: WalletResponse | null;
  /** How the phone step works right now (an owner setting): a text-message code, or none. */
  phoneVerification?: "sms" | "unverified";
}

export interface WalletResponse {
  balancePaise: string;
  bankAlias: string;
  delulupayId: string;
  card: { id: string; status: string; lastFour: string; pinSet: boolean } | null;
  creatorUnlocked: boolean;
}

export interface ProductResponse {
  id: string;
  name: string;
  hook: string | null;
  description: string;
  altText: string;
  pricePaise: string;
  category: string;
  templateId: number;
  sellerName: string | null;
  available: boolean;
  zap: boolean;
  /** 'SEED' for platform stock, else the selling company's id. */
  sellerKey?: string;
  /** The store's handle; null for platform stock. */
  storeHandle?: string | null;
  inventoryMode?: "STANDARD_STOCKED" | "EXCLUSIVE" | "UNLIMITED_SEED";
  /** A band, never an exact count. */
  stockBand?: "UNLIMITED" | "IN_STOCK" | "LOW" | "SOLD_OUT";
  /** Exclusive editions: how many are issued of the fixed supply. */
  edition?: { issued: number; supply: number } | null;
  /** The usual price when the product is on sale; null or absent otherwise. Never invented. */
  referencePricePaise?: string | null;
}

/** GET /products/:id: a product, or a bare marker for one that was published and is no longer. */
export type ProductPageResponse =
  | (ProductResponse & { status: "AVAILABLE" })
  | { id: string; status: "UNAVAILABLE" };

export type Speed = "STANDARD" | "EXPRESS" | "ZAP";

export interface QuoteSeller {
  sellerId: string;
  speed: Speed;
  listPaise: string;
  sellerDiscountPaise: string;
  platformDiscountPaise: string;
  deliveryFeePaise: string;
  totalPaise: string;
}

export interface QuoteResponse {
  id: string;
  expiresAt: string;
  configVersion: number;
  totalPaise: string;
  sellers: QuoteSeller[];
}

export interface ReceiptResponse {
  orderId: string;
  paymentReference: string;
  totalPaise: string;
  balanceAfterPaise: string;
  sellers: { sellerId: string; sellerOrderId: string; totalPaise: string }[];
  creatorUnlocked: boolean;
  reversed: boolean;
}

export interface OrderLine {
  id: string;
  productId: string;
  name: string;
  listPaise: string;
  sellerDiscountPaise: string;
  platformDiscountPaise: string;
  editionSerial: number | null;
}

export interface SellerOrder {
  id: string;
  sellerType: string;
  sellerName: string | null;
  status: string;
  listPaise: string;
  sellerDiscountPaise: string;
  platformDiscountPaise: string;
  deliveryFeePaise: string;
  totalPaise: string;
  shipment: {
    speed: Speed;
    placedAt: string;
    packedAt: string;
    shippedAt: string;
    outAt: string;
    deliveredAt: string;
    cancelledAt: string | null;
  } | null;
  lines: OrderLine[];
}

/** Where an order goes (PRD R5.2): the buyer's own copy, decrypted for the buyer only. */
export type OrderDelivery =
  | { kind: "FICTIONAL_SPOT"; text: string }
  | { kind: "ADDRESS"; label: AddressLabel; labelName: string; text: string }
  | { kind: "ADDRESS_REMOVED" };

export interface OrderResponse {
  id: string;
  createdAt: string;
  totalPaise: string;
  paymentReference: string;
  sellerOrders: SellerOrder[];
  /** Present on GET /api/v1/orders/{id} only. */
  delivery?: OrderDelivery | null;
}

export type AddressLabel = "HOME" | "WORK" | "OTHER";

/** One saved address as GET /api/v1/addresses returns it. */
export interface SavedAddress {
  id: string;
  label: AddressLabel;
  labelName: string;
  isDefault: boolean;
  address: {
    recipientName: string;
    line1: string;
    line2: string | null;
    city: string;
    state: string;
    postalCode: string;
    country: "IN";
  };
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface AddressesResponse {
  items: SavedAddress[];
  max: number;
}

export interface StatementItem {
  postingId: string;
  /** Null on a sale credited to a seller (0060): the journal is the buyer's order. */
  journalId: string | null;
  eventType: string;
  createdAt: string;
  amountPaise: string;
  balanceAfterPaise: string;
  orderGroupId: string | null;
  memo: string | null;
}

export interface CollectionItem {
  id: string;
  productId: string;
  name: string;
  orderLineId: string | null;
  state: string;
  acquiredAt: string;
}

/** Cart API bodies (money fields are decimal strings). */
export type LineIssue = "UNAVAILABLE" | "SOLD_OUT" | "ALREADY_OWNED" | "SELF_PURCHASE";

export interface CartLineResponse {
  productId: string;
  versionId: string;
  name: string;
  hook: string | null;
  altText: string;
  templateId: number;
  pricePaise: string;
  category: string;
  available: boolean;
  offersExpress: boolean;
  zapAvailable: boolean;
  freeStandardDelivery: boolean;
  issue: LineIssue | null;
  addedAt: string;
}

export interface CartGroupResponse {
  sellerKey: string;
  sellerName: string;
  lines: CartLineResponse[];
}

export interface PreviewSeller {
  sellerKey: string;
  sellerName: string;
  speed: Speed;
  speedsOffered: Speed[];
  productIds: string[];
  itemTotalPaise: string;
  sellerDiscountPaise: string;
  platformDiscountPaise: string;
  deliveryFeePaise: string;
  totalPaise: string;
  /** Every offered speed with the delivery fee it would cost for this seller (same pricing path). */
  speedOptions: { speed: Speed; deliveryFeePaise: string }[];
}

export interface PreviewResponse {
  sellers: PreviewSeller[];
  totalPaise: string;
  balancePaise: string | null;
  balanceAfterPaise: string | null;
  couponCode: string | null;
  couponError: string | null;
  issues: { productId: string; issue: LineIssue }[];
}

export interface CartResponse {
  lineCount: number;
  maxLines: number;
  groups: CartGroupResponse[];
  preview: PreviewResponse | null;
  previewError: string | null;
}

export interface CartMergeResponse extends CartResponse {
  skipped: { productId: string; reason: string }[];
}
