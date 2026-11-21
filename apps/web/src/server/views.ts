import "./server-only";
import { type ErrorCode, serializePaise } from "@delulu/core";
import type {
  Cart,
  CartLine,
  CartMergeSkip,
  CartPreview,
  CatalogProduct,
  CheckoutSessionResult,
  CollectionItem,
  Company,
  CompanyQuote,
  CompanyReceipt,
  CreatorAccess,
  OnboardingStatus,
  OrderView,
  PassportProgress,
  PayReceipt,
  ReliefClaim,
  ReliefStatus,
  SavedProduct,
  StatementRow,
  Store,
  Wallet,
} from "@delulu/db/runtime";

/**
 * Response shapes (LLD §8.1): money is a decimal string in a field ending in `Paise`, times are ISO
 * strings. These are the only places a db type becomes JSON, so nothing private slips through by
 * spreading a row: every field is named.
 */

const paise = serializePaise;
const iso = (d: Date): string => d.toISOString();

export function onboardingView(s: OnboardingStatus) {
  return {
    hasProfile: s.hasProfile,
    phoneVerified: s.phoneVerified,
    hasBirthdate: s.hasBirthdate,
    isAdult: s.isAdult,
    provisioned: s.provisioned,
    pinSet: s.pinSet,
  };
}

export function walletView(w: Wallet) {
  return {
    balancePaise: paise(w.balancePaise),
    bankAlias: w.bankAlias,
    delulupayId: w.delulupayId,
    card:
      w.cardId === null
        ? null
        : { id: w.cardId, status: w.cardStatus, lastFour: w.cardLastFour, pinSet: w.pinSet },
    creatorUnlocked: w.creatorUnlocked,
  };
}

export function statementRowView(r: StatementRow) {
  return {
    postingId: r.postingId.toString(),
    journalId: r.journalId,
    eventType: r.eventType,
    createdAt: iso(r.createdAt),
    amountPaise: paise(r.amountPaise),
    balanceAfterPaise: paise(r.balanceAfterPaise),
    orderGroupId: r.orderGroupId,
    memo: r.memo,
  };
}

export function orderView(o: OrderView) {
  return {
    id: o.orderGroupId,
    createdAt: iso(o.createdAt),
    totalPaise: paise(o.totalPaise),
    paymentReference: o.paymentReference,
    sellerOrders: o.sellerOrders.map((so) => ({
      id: so.sellerOrderId,
      sellerType: so.sellerType,
      sellerName: so.sellerName,
      status: so.status,
      listPaise: paise(so.listPaise),
      sellerDiscountPaise: paise(so.sellerDiscountPaise),
      platformDiscountPaise: paise(so.platformDiscountPaise),
      deliveryFeePaise: paise(so.deliveryFeePaise),
      totalPaise: paise(so.totalPaise),
      shipment: so.shipment && {
        speed: so.shipment.speed,
        placedAt: iso(so.shipment.placedAt),
        packedAt: iso(so.shipment.packedAt),
        shippedAt: iso(so.shipment.shippedAt),
        outAt: iso(so.shipment.outAt),
        deliveredAt: iso(so.shipment.deliveredAt),
        cancelledAt: so.shipment.cancelledAt && iso(so.shipment.cancelledAt),
      },
      lines: so.lines.map((l) => ({
        id: l.orderLineId,
        productId: l.productId,
        name: l.name,
        listPaise: paise(l.listPaise),
        sellerDiscountPaise: paise(l.sellerDiscountPaise),
        platformDiscountPaise: paise(l.platformDiscountPaise),
        editionSerial: l.editionSerial,
      })),
    })),
  };
}

export function collectionItemView(c: CollectionItem) {
  return {
    id: c.ownershipId,
    productId: c.productId,
    name: c.name,
    orderLineId: c.orderLineId,
    state: c.state,
    acquiredAt: iso(c.acquiredAt),
  };
}

export function productView(p: CatalogProduct) {
  return {
    id: p.productId,
    name: p.name,
    hook: p.hook,
    description: p.description,
    altText: p.altText,
    pricePaise: paise(p.pricePaise),
    category: p.category,
    templateId: p.templateId,
    sellerName: p.sellerName,
    available: p.available,
    zap: p.zap,
  };
}

export function checkoutSessionView(s: CheckoutSessionResult) {
  return {
    id: s.sessionId,
    expiresAt: iso(s.expiresAt),
    configVersion: s.configVersion,
    totalPaise: paise(s.totalPaise),
    sellers: s.sellers.map((x) => ({
      sellerId: x.sellerId,
      speed: x.speed,
      listPaise: paise(x.listPaise),
      sellerDiscountPaise: paise(x.sellerDiscountPaise),
      platformDiscountPaise: paise(x.platformDiscountPaise),
      deliveryFeePaise: paise(x.deliveryFeeBuyerPaise),
      totalPaise: paise(x.buyerPaise),
    })),
  };
}

export function receiptView(r: PayReceipt) {
  return {
    orderId: r.orderGroupId,
    paymentReference: r.paymentReference,
    totalPaise: paise(r.totalPaise),
    balanceAfterPaise: paise(r.balanceAfterPaise),
    sellers: r.sellers.map((s) => ({
      sellerId: s.sellerId,
      sellerOrderId: s.sellerOrderId,
      totalPaise: paise(s.totalPaise),
    })),
    creatorUnlocked: r.creatorUnlocked,
    reversed: r.reversed,
  };
}

export function cartLineView(l: CartLine) {
  return {
    productId: l.productId,
    versionId: l.versionId,
    name: l.name,
    hook: l.hook,
    altText: l.altText,
    templateId: l.templateId,
    pricePaise: paise(l.pricePaise),
    category: l.category,
    available: l.available,
    offersExpress: l.offersExpress,
    zapAvailable: l.zapAvailable,
    freeStandardDelivery: l.freeStandardDelivery,
    issue: l.issue,
    addedAt: iso(l.addedAt),
  };
}

export function cartPreviewView(p: CartPreview) {
  return {
    sellers: p.sellers.map((s) => ({
      sellerKey: s.sellerKey,
      sellerName: s.sellerName,
      speed: s.speed,
      speedsOffered: s.speedsOffered,
      productIds: s.productIds,
      itemTotalPaise: paise(s.itemTotalPaise),
      sellerDiscountPaise: paise(s.sellerDiscountPaise),
      platformDiscountPaise: paise(s.platformDiscountPaise),
      deliveryFeePaise: paise(s.deliveryFeePaise),
      totalPaise: paise(s.totalPaise),
      speedOptions: s.speedOptions.map((o) => ({
        speed: o.speed,
        deliveryFeePaise: paise(o.deliveryFeePaise),
      })),
    })),
    totalPaise: paise(p.totalPaise),
    balancePaise: p.balancePaise === null ? null : paise(p.balancePaise),
    balanceAfterPaise: p.balanceAfterPaise === null ? null : paise(p.balanceAfterPaise),
    couponCode: p.couponCode,
    couponError: p.couponError,
    issues: p.issues.map((i) => ({ productId: i.productId, issue: i.issue })),
  };
}

/**
 * The cart grouped by seller (first-added order), with its priced preview; `preview` is null and
 * `previewError` names the code when the default options cannot be priced.
 */
export function cartView(
  cart: Cart,
  preview: CartPreview | null,
  previewError: ErrorCode | null,
  maxLines: number,
) {
  const groups: { sellerKey: string; sellerName: string; lines: ReturnType<typeof cartLineView>[] }[] = [];
  for (const line of cart.lines) {
    let group = groups.find((g) => g.sellerKey === line.sellerKey);
    if (!group) {
      group = { sellerKey: line.sellerKey, sellerName: line.sellerName, lines: [] };
      groups.push(group);
    }
    group.lines.push(cartLineView(line));
  }
  return {
    lineCount: cart.lines.length,
    maxLines,
    groups,
    preview: preview === null ? null : cartPreviewView(preview),
    previewError,
  };
}

export function cartMergeSkipView(s: CartMergeSkip) {
  return { productId: s.productId, reason: s.reason };
}

// ------------------------------------------------------------------ selling side (0032-0034)

const isoOrNull = (d: Date | null): string | null => (d === null ? null : iso(d));

export function savedProductView(s: SavedProduct) {
  return {
    productId: s.productId,
    savedAt: iso(s.savedAt),
    published: s.published,
    name: s.name,
    pricePaise: s.pricePaise === null ? null : paise(s.pricePaise),
    sellerName: s.sellerName,
    available: s.available,
    templateId: s.templateId,
    altText: s.altText,
  };
}

export function passportView(p: PassportProgress) {
  return {
    ruleVersion: p.ruleVersion,
    steps: {
      quiz: {
        done: p.quiz.done,
        completedAt: isoOrNull(p.quiz.completedAt),
        failedAttempts: p.quiz.failedAttempts,
      },
      saves: {
        done: p.saves.done,
        completedAt: isoOrNull(p.saves.completedAt),
        count: p.saves.count,
        required: p.saves.required,
      },
      concept: { done: p.concept.done, completedAt: isoOrNull(p.concept.completedAt), text: p.concept.text },
    },
    completedAt: isoOrNull(p.completedAt),
  };
}

export function creatorAccessView(a: CreatorAccess) {
  return {
    unlocked: a.unlocked,
    source: a.source,
    unlockedAt: isoOrNull(a.unlockedAt),
    ruleVersion: a.ruleVersion,
    routes: {
      spend: {
        balancePaise: a.routes.spend.balancePaise === null ? null : paise(a.routes.spend.balancePaise),
        thresholdPaise: paise(a.routes.spend.thresholdPaise),
        reached: a.routes.spend.reached,
        reachedAt: isoOrNull(a.routes.spend.reachedAt),
      },
      passport: passportView(a.routes.passport),
    },
  };
}

export function reliefStatusView(r: ReliefStatus) {
  return {
    eligible: r.eligible,
    reason: r.reason,
    claimsUsed: r.claimsUsed,
    claimsMax: r.claimsMax,
    claimsRemaining: r.claimsRemaining,
    balancePaise: r.balancePaise === null ? null : paise(r.balancePaise),
    ceilingPaise: paise(r.ceilingPaise),
    grantPaise: paise(r.grantPaise),
    nextResetAt: iso(r.nextResetAt),
  };
}

export function reliefClaimView(r: ReliefClaim) {
  return { ...reliefStatusView(r), productId: r.productId, grantedPaise: paise(r.grantedPaise) };
}

export function companyQuoteView(q: CompanyQuote) {
  return {
    sessionId: q.sessionId,
    expiresAt: iso(q.expiresAt),
    handle: q.handle,
    displayName: q.displayName,
    description: q.description,
    feePaise: paise(q.feePaise),
    sponsorshipPaise: paise(q.sponsorshipPaise),
    payablePaise: paise(q.payablePaise),
    balancePaise: paise(q.balancePaise),
    balanceAfterPaise: q.balanceAfterPaise === null ? null : paise(q.balanceAfterPaise),
    sufficient: q.sufficient,
  };
}

export function companyReceiptView(r: CompanyReceipt) {
  return {
    companyId: r.companyId,
    handle: r.handle,
    displayName: r.displayName,
    tier: r.tier,
    warehouseId: r.warehouseId,
    feePaise: paise(r.feePaise),
    paidPaise: paise(r.paidPaise),
    sponsorshipPaise: paise(r.sponsorshipPaise),
    balanceAfterPaise: paise(r.balanceAfterPaise),
    paymentReference: r.paymentReference,
    replayed: r.replayed,
  };
}

export function companyView(c: Company) {
  return {
    id: c.companyId,
    handle: c.handle,
    displayName: c.displayName,
    description: c.description,
    tier: c.tier,
    registeredAt: iso(c.registeredAt),
    warehouses: {
      count: c.warehouses.count,
      capacity: c.warehouses.capacity,
      used: c.warehouses.used,
      starter: c.warehouses.starter && {
        id: c.warehouses.starter.id,
        capacity: c.warehouses.starter.capacity,
        used: c.warehouses.starter.used,
      },
    },
  };
}

export function storeView(s: Store) {
  return { handle: s.handle, displayName: s.displayName, description: s.description, tier: s.tier };
}
