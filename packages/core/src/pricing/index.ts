/**
 * The single pricing function (LLD §5.1). Every amount in a purchase comes from `price()`.
 * Pure: no clock, no randomness, no I/O. Money is bigint paise throughout.
 */
import { DomainError } from "../errors/index";
import { MAX_PRICE_PAISE, MIN_PRICE_PAISE, PAISE_PER_RUPEE, type Paise } from "../money/index";

export type Speed = "STANDARD" | "EXPRESS" | "ZAP";
export const SEED_SELLER = "SEED";
/** Account keys used in postings besides seller ids. */
export const RESERVED_ACCOUNTS = ["BUYER", "MINT", "SINK"] as const;

export type LineIn = {
  productId: string;
  /** `'SEED'` for platform seed stock, otherwise the selling company's id. */
  sellerId: string;
  listPaise: Paise;
  /** Merchant-funded free Standard delivery offered on this product. */
  freeStdDelivery: boolean;
};

export type CouponDiscount = { kind: "PERCENT"; percent: number } | { kind: "FLAT"; amountPaise: Paise };

export type Coupon =
  | { scope: "MERCHANT"; companyId: string; discount: CouponDiscount; minSpendPaise?: Paise }
  | { scope: "PLATFORM"; discount: CouponDiscount; minSpendPaise?: Paise };

export type PricingConfig = {
  deliveryFeePaise: Readonly<Record<Speed, Paise>>;
  /** Marketplace fee percent on the price after seller discount (whole percent). */
  feePercent: number;
  /** Smallest and largest whole percent a PERCENT coupon may give. */
  couponPercentMin: number;
  couponPercentMax: number;
};

export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  deliveryFeePaise: {
    STANDARD: 1_000n * PAISE_PER_RUPEE,
    EXPRESS: 10_000n * PAISE_PER_RUPEE,
    ZAP: 50_000n * PAISE_PER_RUPEE,
  },
  feePercent: 5,
  couponPercentMin: 1,
  couponPercentMax: 90,
};

export type Quote = {
  lines: readonly LineIn[];
  coupon?: Coupon;
  /** Delivery speed per seller order; key `'SEED'` for seed lines. */
  speedBySeller: ReadonlyMap<string, Speed>;
  isMember: boolean;
  cfg: PricingConfig;
};

export type LineOut = {
  productId: string;
  sellerId: string;
  listPaise: Paise;
  sellerDisc: Paise;
  platformDisc: Paise;
  fee: Paise;
};

export type SellerOut = {
  sellerId: string;
  speed: Speed;
  list: Paise;
  sellerDisc: Paise;
  platformDisc: Paise;
  fee: Paise;
  deliveryBuyer: Paise;
  deliverySeller: Paise;
  /** Seller credit: Σ(L − Ds − F) − S_seller. For seed this amount goes to SINK instead. */
  net: Paise;
};

export type Posting = { account: string; amountPaise: Paise };

export type Priced = {
  lines: LineOut[];
  perSeller: SellerOut[];
  buyerTotal: Paise;
  mint: Paise;
  sink: Paise;
  postings: Posting[];
};

/**
 * Split `total` across `weights` in proportion, each share floored, remainder added to the last share.
 * The shares always sum to exactly `total`.
 */
export function allocateProportionally(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) throw new DomainError("VALIDATION_FAILED", "no weights to allocate across");
  const sumW = weights.reduce((a, b) => a + b, 0n);
  if (sumW <= 0n || weights.some((w) => w < 0n)) {
    throw new DomainError("VALIDATION_FAILED", "allocation weights must be non-negative with a positive sum");
  }
  const shares = weights.map((w) => (total * w) / sumW);
  const allocated = shares.reduce((a, b) => a + b, 0n);
  shares[shares.length - 1] = (shares[shares.length - 1] ?? 0n) + (total - allocated);
  return shares;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function validateLines(lines: readonly LineIn[]): void {
  if (lines.length === 0) throw new DomainError("VALIDATION_FAILED", "a quote needs at least one line");
  for (const l of lines) {
    if ((RESERVED_ACCOUNTS as readonly string[]).includes(l.sellerId) || l.sellerId.length === 0) {
      throw new DomainError("VALIDATION_FAILED", "invalid seller id", { productId: l.productId });
    }
    if (
      l.listPaise < MIN_PRICE_PAISE ||
      l.listPaise > MAX_PRICE_PAISE ||
      l.listPaise % PAISE_PER_RUPEE !== 0n
    ) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "list price must be whole rupees between ₹100 and ₹100 crore",
        {
          productId: l.productId,
        },
      );
    }
  }
}

function validateConfig(cfg: PricingConfig): void {
  if (!Number.isInteger(cfg.feePercent) || cfg.feePercent < 0 || cfg.feePercent > 100) {
    throw new DomainError("VALIDATION_FAILED", "feePercent must be a whole percent 0–100");
  }
  if (
    !Number.isInteger(cfg.couponPercentMin) ||
    !Number.isInteger(cfg.couponPercentMax) ||
    cfg.couponPercentMin < 1 ||
    cfg.couponPercentMax > 100 ||
    cfg.couponPercentMin > cfg.couponPercentMax
  ) {
    throw new DomainError("VALIDATION_FAILED", "coupon percent range must be whole percents within 1–100");
  }
  for (const fee of Object.values(cfg.deliveryFeePaise)) {
    if (fee < 0n) throw new DomainError("VALIDATION_FAILED", "delivery fees must be non-negative");
  }
}

function validateCoupon(c: Coupon, cfg: PricingConfig): void {
  const d = c.discount;
  if (
    d.kind === "PERCENT" &&
    (!Number.isInteger(d.percent) || d.percent < cfg.couponPercentMin || d.percent > cfg.couponPercentMax)
  ) {
    throw new DomainError(
      "COUPON_INVALID",
      `percent coupon must be a whole percent ${cfg.couponPercentMin}–${cfg.couponPercentMax}`,
    );
  }
  if (d.kind === "FLAT" && d.amountPaise <= 0n) {
    throw new DomainError("COUPON_INVALID", "flat coupon amount must be positive");
  }
}

/**
 * Discount per eligible line on `bases`, capped so `base − discount ≥ ₹100` (MIN_PRICE_PAISE).
 * A PERCENT discount is per line. A FLAT amount is split in proportion to the bases; any share above a
 * line's room is re-split (again by base) across lines that still have room, until the whole amount is
 * given or every line is at ₹100. Returns one entry per base (in the same order).
 */
function discountsOn(discount: CouponDiscount, bases: readonly bigint[]): bigint[] {
  const rooms = bases.map((b) => (b > MIN_PRICE_PAISE ? b - MIN_PRICE_PAISE : 0n));
  if (discount.kind === "PERCENT") {
    return bases.map((b, i) => min((b * BigInt(discount.percent)) / 100n, rooms[i] ?? 0n));
  }
  const given = bases.map(() => 0n);
  let remaining = discount.amountPaise;
  // Each pass either gives all of `remaining` or fills at least one line, so it ends within n passes.
  while (remaining > 0n) {
    const open = bases.map((_, i) => i).filter((i) => (given[i] ?? 0n) < (rooms[i] ?? 0n));
    if (open.length === 0) break;
    const shares = allocateProportionally(
      remaining,
      open.map((i) => bases[i] ?? 0n),
    );
    open.forEach((i, k) => {
      const take = min(shares[k] ?? 0n, (rooms[i] ?? 0n) - (given[i] ?? 0n));
      given[i] = (given[i] ?? 0n) + take;
      remaining -= take;
    });
  }
  return given;
}

function deliveryFee(speed: Speed, isMember: boolean, cfg: PricingConfig): Paise {
  const base = cfg.deliveryFeePaise[speed];
  if (!isMember) return base;
  return speed === "ZAP" ? base / 2n : 0n;
}

export function price(q: Quote): Priced {
  validateConfig(q.cfg);
  validateLines(q.lines);

  const lines: LineOut[] = q.lines.map((l) => ({
    productId: l.productId,
    sellerId: l.sellerId,
    listPaise: l.listPaise,
    sellerDisc: 0n,
    platformDisc: 0n,
    fee: 0n,
  }));

  // 1–2. Coupon discounts.
  const coupon = q.coupon;
  if (coupon) {
    validateCoupon(coupon, q.cfg);
    if (coupon.scope === "MERCHANT" && coupon.companyId === SEED_SELLER) {
      throw new DomainError("COUPON_NOT_APPLICABLE", "merchant coupons cannot apply to seed stock", {
        reason: "SEED_LINES",
      });
    }
    const eligible = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => (coupon.scope === "MERCHANT" ? l.sellerId === coupon.companyId : true));
    if (eligible.length === 0) {
      throw new DomainError("COUPON_NOT_APPLICABLE", "coupon applies to no item in the cart", {
        reason: "NO_ELIGIBLE_LINES",
      });
    }
    const eligibleSpend = eligible.reduce((a, { l }) => a + l.listPaise, 0n);
    if (coupon.minSpendPaise !== undefined && eligibleSpend < coupon.minSpendPaise) {
      throw new DomainError("COUPON_NOT_APPLICABLE", "minimum spend not met", { reason: "MIN_SPEND" });
    }
    if (coupon.scope === "MERCHANT") {
      const ds = discountsOn(
        coupon.discount,
        eligible.map(({ l }) => l.listPaise),
      );
      eligible.forEach(({ l }, k) => {
        l.sellerDisc = ds[k] ?? 0n;
      });
    } else {
      const dp = discountsOn(
        coupon.discount,
        eligible.map(({ l }) => l.listPaise - l.sellerDisc),
      );
      eligible.forEach(({ l }, k) => {
        l.platformDisc = dp[k] ?? 0n;
      });
    }
  }

  // 3. Fee per line.
  const feePct = BigInt(q.cfg.feePercent);
  for (const l of lines) {
    l.fee = l.sellerId === SEED_SELLER ? 0n : ((l.listPaise - l.sellerDisc) * feePct) / 100n;
  }

  // 4. Per seller order, in order of first appearance.
  const sellerIds = [...new Set(lines.map((l) => l.sellerId))];
  const perSeller: SellerOut[] = sellerIds.map((sellerId) => {
    const speed = q.speedBySeller.get(sellerId);
    if (!speed)
      throw new DomainError("VALIDATION_FAILED", "no delivery speed chosen for a seller", { sellerId });
    const own = lines.filter((l) => l.sellerId === sellerId);
    const ownIn = q.lines.filter((l) => l.sellerId === sellerId);
    const s = deliveryFee(speed, q.isMember, q.cfg);
    const merchantFunded = speed === "STANDARD" && ownIn.every((l) => l.freeStdDelivery);
    const deliverySeller = merchantFunded ? s : 0n;
    const deliveryBuyer = merchantFunded ? 0n : s;
    const sum = (f: (l: LineOut) => bigint) => own.reduce((a, l) => a + f(l), 0n);
    const net = sum((l) => l.listPaise - l.sellerDisc - l.fee) - deliverySeller;
    if (net < 0n) {
      throw new DomainError("DELIVERY_UNAVAILABLE", "seller-funded delivery exceeds the seller's proceeds", {
        sellerId,
      });
    }
    return {
      sellerId,
      speed,
      list: sum((l) => l.listPaise),
      sellerDisc: sum((l) => l.sellerDisc),
      platformDisc: sum((l) => l.platformDisc),
      fee: sum((l) => l.fee),
      deliveryBuyer,
      deliverySeller,
      net,
    };
  });

  // 5. Postings.
  let buyerTotal = 0n;
  let mint = 0n;
  let sink = 0n;
  const sellerCredits: Posting[] = [];
  for (const s of perSeller) {
    buyerTotal += s.list - s.sellerDisc - s.platformDisc + s.deliveryBuyer;
    mint += s.platformDisc;
    sink += s.fee + s.deliveryBuyer + s.deliverySeller;
    if (s.sellerId === SEED_SELLER)
      sink += s.net; // seed proceeds go to SINK in place of a seller credit
    else if (s.net > 0n) sellerCredits.push({ account: s.sellerId, amountPaise: s.net });
  }

  const postings: Posting[] = [{ account: "BUYER", amountPaise: -buyerTotal }];
  if (mint > 0n) postings.push({ account: "MINT", amountPaise: -mint });
  postings.push(...sellerCredits);
  if (sink > 0n) postings.push({ account: "SINK", amountPaise: sink });

  // Invariants (a violation here is a bug, not a user error).
  if (postings.reduce((a, p) => a + p.amountPaise, 0n) !== 0n)
    throw new Error("pricing: postings do not sum to zero");
  if (buyerTotal <= 0n) throw new Error("pricing: buyer total must be positive");

  return { lines, perSeller, buyerTotal, mint, sink, postings };
}

export * from "./reference-price";
export * from "./sale-price";
