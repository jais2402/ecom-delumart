import "./server-only";
import { serializePaise } from "@delulu/core";
import type {
  CatalogProduct,
  CheckoutSessionResult,
  CollectionItem,
  OnboardingStatus,
  OrderView,
  PayReceipt,
  StatementRow,
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
