/**
 * The signed-in person's cart (PRD R2.2, migration 0028). Every call runs a SECURITY DEFINER
 * function that derives the actor from the sign-in session: no call names a user, so user A can
 * never read or change user B's cart. The cart is a convenience list: it reserves no stock and
 * guarantees no price. Money is bigint paise.
 *
 * The preview prices the purchasable lines through exactly the path a checkout session takes
 * (core.resolve_cart, then priceInputs() of checkout.ts, i.e. price() from @delulu/core), so the
 * preview and the checkout session created from the same choices cannot disagree.
 */
import { DomainError, ERROR_CODES, type ErrorCode, type Speed } from "@delulu/core";
import type { Pool, PoolClient } from "pg";
import {
  type CartInputs,
  type CheckoutSessionResult,
  createCheckoutSession,
  priceInputs,
  type Refusal,
} from "./checkout";
import { asPay, asWeb, domainErrorOf, requireUuid } from "./command";

// ---------------------------------------------------------------------------- public types

/** Why a line can no longer be bought; null when it can. */
export type CartIssue = "UNAVAILABLE" | "SOLD_OUT" | "ALREADY_OWNED" | "SELF_PURCHASE";

export interface CartLine {
  productId: string;
  /** The product's current version. */
  versionId: string;
  name: string;
  hook: string | null;
  altText: string;
  templateId: number;
  /** The current list price: shown, never guaranteed. */
  pricePaise: bigint;
  category: string;
  /** "SEED" for platform seed stock, otherwise the selling company's id. */
  sellerKey: string;
  /** The company's name, or "DeluluMart Originals" for seed stock. */
  sellerName: string;
  /** Published and in stock. */
  available: boolean;
  offersExpress: boolean;
  zapAvailable: boolean;
  /** The merchant pays Standard delivery for this product. */
  freeStandardDelivery: boolean;
  issue: CartIssue | null;
  addedAt: Date;
}

export interface Cart {
  /** In the order they were added. */
  lines: CartLine[];
}

export interface CartMergeSkip {
  productId: string;
  reason: ErrorCode;
}

export interface CartPreviewSeller {
  sellerKey: string;
  sellerName: string;
  speed: Speed;
  /** The speeds this seller offers for every purchasable line of theirs. */
  speedsOffered: Speed[];
  productIds: string[];
  /** Sum of list prices. */
  itemTotalPaise: bigint;
  sellerDiscountPaise: bigint;
  platformDiscountPaise: bigint;
  /** Delivery fee the buyer pays (zero when the merchant pays Standard delivery). */
  deliveryFeePaise: bigint;
  /** What the buyer pays for this seller order. */
  totalPaise: bigint;
  /**
   * Every speed offered that can be priced, with the delivery fee the buyer would pay for this
   * seller with it (the other sellers' speeds and the coupon unchanged), from the same pricing path.
   */
  speedOptions: { speed: Speed; deliveryFeePaise: bigint }[];
}

export interface CartPreview {
  sellers: CartPreviewSeller[];
  totalPaise: bigint;
  /** Null before the account is provisioned. */
  balancePaise: bigint | null;
  balanceAfterPaise: bigint | null;
  /** The coupon code applied (normalised), or null. */
  couponCode: string | null;
  /** Why the coupon given was not applied; the preview is then priced without it. */
  couponError: ErrorCode | null;
  /** Lines that cannot be bought now; they are left out of the totals. */
  issues: { productId: string; issue: CartIssue }[];
}

export interface CartPreviewInput {
  authSessionId: string;
  /** Speed per seller key; a seller not named gets STANDARD. */
  speedBySeller?: Readonly<Record<string, Speed>>;
  couponCode?: string;
}

export interface CheckoutFromCartInput extends CartPreviewInput {
  idempotencyKey: string;
  /** One of the caller's own saved addresses; omitted: the fictional delivery spot. */
  addressId?: string;
}

// ---------------------------------------------------------------------------- parsing

const ISSUES: readonly CartIssue[] = ["UNAVAILABLE", "SOLD_OUT", "ALREADY_OWNED", "SELF_PURCHASE"];
const SPEEDS: readonly Speed[] = ["STANDARD", "EXPRESS", "ZAP"];

interface StoredLine {
  productId: string;
  versionId: string;
  name: string;
  hook: string | null;
  altText: string;
  templateId: number;
  pricePaise: string;
  category: string;
  sellerKey: string;
  sellerName: string;
  available: boolean;
  offersExpress: boolean;
  zapAvailable: boolean;
  freeStandardDelivery: boolean;
  issue: string | null;
  addedAt: string;
}

interface StoredCart {
  lines: StoredLine[];
  skipped?: { productId: string; reason: string }[];
}

function issueOf(v: string | null): CartIssue | null {
  return v !== null && (ISSUES as readonly string[]).includes(v) ? (v as CartIssue) : null;
}

function cartOf(s: StoredCart): Cart {
  return {
    lines: s.lines.map((l) => ({
      productId: l.productId,
      versionId: l.versionId,
      name: l.name,
      hook: l.hook,
      altText: l.altText,
      templateId: l.templateId,
      pricePaise: BigInt(l.pricePaise),
      category: l.category,
      sellerKey: l.sellerKey,
      sellerName: l.sellerName,
      available: l.available,
      offersExpress: l.offersExpress,
      zapAvailable: l.zapAvailable,
      freeStandardDelivery: l.freeStandardDelivery,
      issue: issueOf(l.issue),
      addedAt: new Date(l.addedAt),
    })),
  };
}

function codeOf(v: string): ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(v) ? (v as ErrorCode) : "VALIDATION_FAILED";
}

async function cartCall(c: PoolClient, sql: string, params: unknown[]): Promise<StoredCart> {
  const { rows } = await c.query<{ r: StoredCart }>(sql, params);
  const r = rows[0]?.r;
  if (!r) throw new Error("cart command returned nothing");
  return r;
}

// ---------------------------------------------------------------------------- commands

/** The caller's cart. */
export async function myCart(pool: Pool, input: { authSessionId: string }): Promise<Cart> {
  return asWeb(pool, input.authSessionId, async (c) =>
    cartOf(await cartCall(c, "SELECT core.my_cart() AS r", [])),
  );
}

/**
 * Adds a published product (no-op when already in the cart). Refuses PRODUCT_UNAVAILABLE,
 * ALREADY_OWNED, SELF_PURCHASE, CART_FULL, or PHONE_REQUIRED before onboarding.
 */
export async function cartAdd(
  pool: Pool,
  input: { authSessionId: string; productId: string },
): Promise<Cart> {
  requireUuid(input.productId, "productId");
  return asWeb(pool, input.authSessionId, async (c) =>
    cartOf(await cartCall(c, "SELECT core.cart_add($1) AS r", [input.productId])),
  );
}

/** Removes one line (no-op when it is not in the cart). */
export async function cartRemove(
  pool: Pool,
  input: { authSessionId: string; productId: string },
): Promise<Cart> {
  requireUuid(input.productId, "productId");
  return asWeb(pool, input.authSessionId, async (c) =>
    cartOf(await cartCall(c, "SELECT core.cart_remove($1) AS r", [input.productId])),
  );
}

/** Empties the cart. */
export async function cartClear(pool: Pool, input: { authSessionId: string }): Promise<Cart> {
  return asWeb(pool, input.authSessionId, async (c) =>
    cartOf(await cartCall(c, "SELECT core.cart_clear() AS r", [])),
  );
}

/**
 * Sign-in merge of the browser cart: adds each eligible product while there is room and skips
 * the rest, each with the code cart_add would have refused it with.
 */
export async function cartMerge(
  pool: Pool,
  input: { authSessionId: string; productIds: readonly string[] },
): Promise<{ cart: Cart; skipped: CartMergeSkip[] }> {
  for (const id of input.productIds) requireUuid(id, "productId");
  return asWeb(pool, input.authSessionId, async (c) => {
    const r = await cartCall(c, "SELECT core.cart_merge($1::uuid[]) AS r", [input.productIds]);
    return {
      cart: cartOf(r),
      skipped: (r.skipped ?? []).map((s) => ({ productId: s.productId, reason: codeOf(s.reason) })),
    };
  });
}

// ---------------------------------------------------------------------------- preview

function requireSpeeds(speeds: Readonly<Record<string, Speed>> | undefined): void {
  for (const [seller, speed] of Object.entries(speeds ?? {})) {
    if (!SPEEDS.includes(speed))
      throw new DomainError("VALIDATION_FAILED", "unknown delivery speed", { seller });
  }
}

/** Sellers of the lines in first-appearance order, each with the speeds all its lines offer. */
function sellersOf(lines: readonly CartLine[]): Map<string, { name: string; lines: CartLine[] }> {
  const out = new Map<string, { name: string; lines: CartLine[] }>();
  for (const l of lines) {
    const s = out.get(l.sellerKey) ?? { name: l.sellerName, lines: [] };
    s.lines.push(l);
    out.set(l.sellerKey, s);
  }
  return out;
}

function speedsOffered(lines: readonly CartLine[]): Speed[] {
  const out: Speed[] = ["STANDARD"];
  if (lines.every((l) => l.offersExpress)) out.push("EXPRESS");
  if (lines.every((l) => l.zapAvailable)) out.push("ZAP");
  return out;
}

/** Speed per seller of the purchasable lines: the one asked for, STANDARD otherwise. */
function chosenSpeeds(
  purchasable: readonly CartLine[],
  requested: Readonly<Record<string, Speed>> | undefined,
): Record<string, Speed> {
  const out: Record<string, Speed> = {};
  for (const key of sellersOf(purchasable).keys()) out[key] = requested?.[key] ?? "STANDARD";
  return out;
}

const isCouponRefusal = (code: unknown): boolean =>
  code === "COUPON_INVALID" || code === "COUPON_NOT_APPLICABLE";

type Resolved = { inputs: CartInputs } | { refused: Refusal };

async function resolve(c: PoolClient, choices: unknown): Promise<Resolved> {
  const { rows } = await c.query<{ r: { inputs?: CartInputs; error?: Refusal } }>(
    "SELECT core.cart_quote_inputs($1::jsonb) AS r",
    [JSON.stringify(choices)],
  );
  const r = rows[0]?.r;
  return r?.inputs ? { inputs: r.inputs } : { refused: r?.error ?? {} };
}

type PreviewOutcome = { ok: { cart: Cart; preview: CartPreview } } | { refused: Refusal; cart: Cart };

/**
 * The priced preview of the purchasable lines for the chosen speeds and coupon. A coupon that
 * cannot be used gives the preview without it and `couponError`; any other refusal (a speed a
 * seller does not offer, ...) is thrown. A failed coupon lookup is counted exactly as at
 * checkout (the preview is no unlimited oracle for coupon codes), so it commits.
 */
export async function previewCart(pool: Pool, input: CartPreviewInput): Promise<CartPreview> {
  const r = await cartWithPreview(pool, input);
  if (r.preview === null) throw r.previewError ?? new DomainError("VALIDATION_FAILED", "no preview");
  return r.preview;
}

export interface CartWithPreview {
  cart: Cart;
  /** Null when these options cannot be priced; `previewError` then says why. */
  preview: CartPreview | null;
  /** E.g. DELIVERY_UNAVAILABLE: merchant-paid Standard delivery above the seller's proceeds. */
  previewError: DomainError | null;
}

/**
 * The cart and its preview, read in one transaction (GET /cart). A refusal to price these options
 * does not hide the cart: it is returned with `preview: null` and the refusal in `previewError`.
 */
export async function cartWithPreview(pool: Pool, input: CartPreviewInput): Promise<CartWithPreview> {
  requireSpeeds(input.speedBySeller);
  const outcome = await asPay<PreviewOutcome>(pool, input.authSessionId, async (c) => {
    const cart = cartOf(await cartCall(c, "SELECT core.my_cart() AS r", []));
    const purchasable = cart.lines.filter((l) => l.issue === null);
    const issues = cart.lines.flatMap((l) =>
      l.issue === null ? [] : [{ productId: l.productId, issue: l.issue }],
    );
    const wallet = await c.query<{ b: string }>("SELECT balance_paise::text AS b FROM core.my_wallet()");
    const balance = wallet.rows[0] ? BigInt(wallet.rows[0].b) : null;
    const empty: CartPreview = {
      sellers: [],
      totalPaise: 0n,
      balancePaise: balance,
      balanceAfterPaise: balance,
      couponCode: null,
      couponError: null,
      issues,
    };
    if (purchasable.length === 0) return { ok: { cart, preview: empty } };

    const speeds = chosenSpeeds(purchasable, input.speedBySeller);
    const productIds = purchasable.map((l) => l.productId);
    let couponCode = input.couponCode ?? null;
    let couponError: ErrorCode | null = null;
    for (;;) {
      const resolved = await resolve(c, { productIds, speedBySeller: speeds, couponCode });
      let refused: Refusal;
      if ("inputs" in resolved) {
        const pricing = await priceInputs(c, resolved.inputs);
        if ("ok" in pricing) {
          const priced = pricing.ok;
          const groups = sellersOf(purchasable);
          const options = new Map<string, { speed: Speed; deliveryFeePaise: bigint }[]>();
          for (const s of priced.perSeller) {
            const list: { speed: Speed; deliveryFeePaise: bigint }[] = [];
            for (const speed of speedsOffered(groups.get(s.sellerId)?.lines ?? [])) {
              if (speed === s.speed) {
                list.push({ speed, deliveryFeePaise: s.deliveryBuyer });
                continue;
              }
              const inputs = resolved.inputs;
              const alt = await priceInputs(c, {
                ...inputs,
                speedBySeller: { ...inputs.speedBySeller, [s.sellerId]: speed },
              });
              const mine = "ok" in alt ? alt.ok.perSeller.find((x) => x.sellerId === s.sellerId) : undefined;
              if (mine) list.push({ speed, deliveryFeePaise: mine.deliveryBuyer });
            }
            options.set(s.sellerId, list);
          }
          const sellers = priced.perSeller.map((s): CartPreviewSeller => {
            const g = groups.get(s.sellerId);
            return {
              speedOptions: options.get(s.sellerId) ?? [],
              sellerKey: s.sellerId,
              sellerName: g?.name ?? "",
              speed: s.speed,
              speedsOffered: speedsOffered(g?.lines ?? []),
              productIds: (g?.lines ?? []).map((l) => l.productId),
              itemTotalPaise: s.list,
              sellerDiscountPaise: s.sellerDisc,
              platformDiscountPaise: s.platformDisc,
              deliveryFeePaise: s.deliveryBuyer,
              totalPaise: s.list - s.sellerDisc - s.platformDisc + s.deliveryBuyer,
            };
          });
          return {
            ok: {
              cart,
              preview: {
                ...empty,
                sellers,
                totalPaise: priced.buyerTotal,
                balanceAfterPaise: balance === null ? null : balance - priced.buyerTotal,
                couponCode: resolved.inputs.coupon === null ? null : (resolved.inputs.coupon.code ?? null),
                couponError,
              },
            },
          };
        }
        refused = pricing.refused;
      } else {
        refused = resolved.refused;
      }
      if (couponCode !== null && isCouponRefusal(refused.code)) {
        couponError = codeOf(String(refused.code));
        couponCode = null;
        continue;
      }
      return { refused, cart };
    }
  });
  if ("refused" in outcome) {
    return { cart: outcome.cart, preview: null, previewError: domainErrorOf(outcome.refused) };
  }
  return { ...outcome.ok, previewError: null };
}

// ---------------------------------------------------------------------------- checkout from the cart

/** The cart read as app_pay (the checkout pool's role). */
async function payCart(pool: Pool, authSessionId: string): Promise<Cart> {
  return asPay(pool, authSessionId, async (c) => cartOf(await cartCall(c, "SELECT core.my_cart() AS r", [])));
}

/** The lines of the cart that cannot be bought now, as CART_CHANGED details. */
function cartChanged(cart: Cart): DomainError | null {
  const issues = cart.lines.flatMap((l) =>
    l.issue === null ? [] : [{ productId: l.productId, issue: l.issue }],
  );
  return issues.length === 0
    ? null
    : new DomainError("CART_CHANGED", "some items in your cart can no longer be bought", { issues });
}

const LINE_REFUSALS: ReadonlySet<ErrorCode> = new Set([
  "SOLD_OUT",
  "PRODUCT_UNAVAILABLE",
  "ALREADY_OWNED",
  "SELF_PURCHASE",
]);

/**
 * A checkout session for the whole server-side cart (all-or-nothing): refuses CART_CHANGED with
 * the per-line issues when any line cannot be bought, otherwise creates the session exactly as
 * createCheckoutSession does for the same lines (cart order), speeds (STANDARD where not given)
 * and coupon.
 */
export async function createCheckoutSessionFromCart(
  pool: Pool,
  input: CheckoutFromCartInput,
): Promise<CheckoutSessionResult> {
  requireSpeeds(input.speedBySeller);
  const cart = await payCart(pool, input.authSessionId);
  const changed = cartChanged(cart);
  if (changed) throw changed;
  if (cart.lines.length === 0) throw new DomainError("VALIDATION_FAILED", "the cart is empty");
  try {
    return await createCheckoutSession(pool, {
      authSessionId: input.authSessionId,
      lines: cart.lines.map((l) => ({ productId: l.productId })),
      speedBySeller: chosenSpeeds(cart.lines, input.speedBySeller),
      ...(input.couponCode === undefined ? {} : { couponCode: input.couponCode }),
      ...(input.addressId === undefined ? {} : { addressId: input.addressId }),
      idempotencyKey: input.idempotencyKey,
    });
  } catch (error) {
    // a line stopped being purchasable after the cart was read: report it per line
    if (error instanceof DomainError && LINE_REFUSALS.has(error.code)) {
      const now = cartChanged(await payCart(pool, input.authSessionId));
      if (now) throw now;
    }
    throw error;
  }
}

/** Per-line issues of the caller's cart (for a failed payment's response). */
export async function cartIssues(
  pool: Pool,
  input: { authSessionId: string },
): Promise<{ productId: string; issue: CartIssue }[]> {
  const cart = await myCart(pool, input);
  return cart.lines.flatMap((l) => (l.issue === null ? [] : [{ productId: l.productId, issue: l.issue }]));
}
