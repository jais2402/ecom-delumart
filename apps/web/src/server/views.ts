import "./server-only";
import { type ErrorCode, serializePaise } from "@delulu/core";
import type {
  AdminStatus,
  AppealQueueItem,
  AppealResolution,
  AppealView,
  BrandProgress,
  Cart,
  CartLine,
  CartMergeSkip,
  CartPreview,
  CaseResolution,
  CatalogProduct,
  CheckoutSessionResult,
  CollectionItem,
  Company,
  CompanyQuote,
  CompanyReceipt,
  CouponTerms,
  CreatorAccess,
  Earnings,
  EarningsTotals,
  Inventory,
  Listing,
  ListingDetail,
  ListingVersion,
  MerchantCoupon,
  MerchantOrder,
  ModerationItem,
  ModerationOutcome,
  MyReport,
  OnboardingStatus,
  OrderView,
  PassportProgress,
  PayReceipt,
  PublicCoupon,
  ReliefClaim,
  ReliefStatus,
  ReportCase,
  ReportReceipt,
  SavedProduct,
  StatementRow,
  Store,
  StoreBlock,
  Wallet,
  WarehouseView,
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
    // ninth review, major 1: true only for a number confirmed by SMS; phoneRecorded says the step is done
    phoneVerified: s.phoneVerified,
    phoneRecorded: s.phoneRecorded,
    phoneReverifyRequired: s.phoneReverifyRequired,
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
    sellerKey: p.sellerKey,
    storeHandle: p.storeHandle,
    inventoryMode: p.inventoryMode,
    stockBand: p.stockBand,
    edition: p.edition && { issued: p.edition.issued, supply: p.edition.supply },
    referencePricePaise: p.referencePricePaise === null ? null : paise(p.referencePricePaise),
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

// ------------------------------------------------------------------ the studio (owner only)

export function listingVersionView(v: ListingVersion) {
  return {
    id: v.versionId,
    revision: v.revision,
    name: v.name,
    hook: v.hook,
    description: v.description,
    altText: v.altText,
    templateId: v.templateId,
    pricePaise: paise(v.pricePaise),
    createdAt: iso(v.createdAt),
  };
}

const reasonsView = (r: readonly { field: string; code: string }[]) =>
  r.map((x) => ({ field: x.field, code: x.code }));

export function listingView(l: Listing) {
  return {
    id: l.productId,
    status: l.status,
    category: l.category,
    inventoryMode: l.inventoryMode,
    quantity: l.quantity,
    offersExpress: l.offersExpress,
    freeStandardDelivery: l.freeStandardDelivery,
    approvedNeedsStock: l.approvedNeedsStock,
    createdAt: iso(l.createdAt),
    updatedAt: isoOrNull(l.updatedAt),
    publishedAt: isoOrNull(l.publishedAt),
    current: l.current && listingVersionView(l.current),
    live: l.live && listingVersionView(l.live),
    pending: l.pending && {
      submissionId: l.pending.submissionId,
      kind: l.pending.kind,
      state: l.pending.state,
      submittedAt: iso(l.pending.submittedAt),
      reasons: reasonsView(l.pending.reasons),
      version: listingVersionView(l.pending.version),
    },
    lastDecision: l.lastDecision && {
      kind: l.lastDecision.kind,
      state: l.lastDecision.state,
      versionId: l.lastDecision.versionId,
      reasons: reasonsView(l.lastDecision.reasons),
      reason: l.lastDecision.reason,
      decidedBy: l.lastDecision.decidedBy,
      decidedAt: isoOrNull(l.lastDecision.decidedAt),
    },
    moderationReason: l.moderationReason,
    stock: { available: l.stock.available, issued: l.stock.issued, retired: l.stock.retired },
    edition: l.edition && { supply: l.edition.supply, issued: l.edition.issued },
    nextAction: l.nextAction,
    sale: {
      active: l.sale.active,
      listPaise: l.sale.listPaise === null ? null : paise(l.sale.listPaise),
      salePaise: l.sale.salePaise === null ? null : paise(l.sale.salePaise),
      startedAt: isoOrNull(l.sale.startedAt),
      referencePaise: l.sale.referencePaise === null ? null : paise(l.sale.referencePaise),
      referenceCeilingPaise:
        l.sale.referenceCeilingPaise === null ? null : paise(l.sale.referenceCeilingPaise),
      canShowReference: l.sale.canShowReference,
      rules: {
        referenceMinHours: l.sale.rules.referenceMinHours,
        referenceLookbackDays: l.sale.rules.referenceLookbackDays,
        priceChangesPerDay: l.sale.rules.priceChangesPerDay,
        priceChangeWindowHours: l.sale.rules.priceChangeWindowHours,
        changesRemaining: l.sale.rules.changesRemaining,
        priceMinPaise: paise(l.sale.rules.priceMinPaise),
        priceMaxPaise: paise(l.sale.rules.priceMaxPaise),
        freeDeliveryMinPaise:
          l.sale.rules.freeDeliveryMinPaise === null ? null : paise(l.sale.rules.freeDeliveryMinPaise),
      },
    },
  };
}

export function listingDetailView(l: ListingDetail) {
  return {
    ...listingView(l),
    appeal: l.appeal && appealView(l.appeal),
    appealable: l.appealable,
    versions: l.versions.map((v) => ({
      ...listingVersionView(v),
      isCurrent: v.isCurrent,
      submissions: v.submissions.map((s) => ({
        kind: s.kind,
        state: s.state,
        reasons: reasonsView(s.reasons),
        reason: s.reason,
        decidedBy: s.decidedBy,
        submittedAt: iso(s.submittedAt),
        decidedAt: isoOrNull(s.decidedAt),
      })),
    })),
    priceHistory: l.priceHistory.map((h) => ({
      versionId: h.versionId,
      pricePaise: paise(h.pricePaise),
      previousPaise: h.previousPaise === null ? null : paise(h.previousPaise),
      reason: h.reason,
      changedAt: iso(h.changedAt),
    })),
  };
}

export function warehouseView(w: WarehouseView) {
  return { id: w.id, kind: w.kind, capacity: w.capacity, used: w.used, zapHub: w.zapHub };
}

// ------------------------------------------------------------------ Super Admin

export function moderationItemView(i: ModerationItem) {
  return {
    submissionId: i.submissionId,
    productId: i.productId,
    versionId: i.versionId,
    kind: i.kind,
    submittedAt: iso(i.submittedAt),
    reasons: reasonsView(i.reasons),
    store: { handle: i.store.handle, displayName: i.store.displayName },
    category: i.category,
    inventoryMode: i.inventoryMode,
    productStatus: i.productStatus,
    version: listingVersionView(i.version),
  };
}

export function moderationOutcomeView(o: ModerationOutcome) {
  return { outcome: o.outcome, productId: o.productId, versionId: o.versionId ?? null };
}

export function appealQueueItemView(a: AppealQueueItem) {
  return {
    appealId: a.appealId,
    productId: a.productId,
    kind: a.kind,
    statement: a.statement,
    createdAt: iso(a.createdAt),
    productStatus: a.productStatus,
    store: { handle: a.store.handle, displayName: a.store.displayName },
    version: a.version && listingVersionView(a.version),
    decision: a.decision && {
      action: a.decision.action,
      reason: a.decision.reason,
      at: isoOrNull(a.decision.at),
      by: a.decision.by,
    },
    evidence: {
      reasons: reasonsView(a.evidence.reasons),
      reports: a.evidence.reports && {
        caseId: a.evidence.reports.caseId,
        reasonCounts: { ...a.evidence.reports.reasonCounts },
        reporterCount: a.evidence.reports.reporterCount,
      },
    },
  };
}

// ------------------------------------------------------------------ trust and safety

export function reportReceiptView(r: ReportReceipt) {
  return {
    reference: r.reference,
    targetType: r.targetType,
    targetId: r.targetId,
    reason: r.reason,
    status: r.status,
    createdAt: iso(r.createdAt),
  };
}

export function myReportView(r: MyReport) {
  return {
    reference: r.reference,
    targetType: r.targetType,
    targetId: r.targetId,
    reason: r.reason,
    status: r.status,
    createdAt: iso(r.createdAt),
    resolvedAt: isoOrNull(r.resolvedAt),
  };
}

export function appealView(a: AppealView) {
  return {
    id: a.appealId,
    productId: a.productId,
    productName: a.productName,
    kind: a.kind,
    status: a.status,
    statement: a.statement,
    createdAt: iso(a.createdAt),
    decidedAt: isoOrNull(a.decidedAt),
    decisionReason: a.decisionReason,
  };
}

export function blockView(b: StoreBlock) {
  return {
    companyId: b.companyId,
    handle: b.handle,
    displayName: b.displayName,
    blockedAt: iso(b.blockedAt),
  };
}

/** A report case for the Super Admin: reporters only as per-case numbers. */
export function reportCaseView(c: ReportCase) {
  return {
    id: c.caseId,
    targetType: c.targetType,
    status: c.status,
    openedAt: iso(c.openedAt),
    autoHidden: c.autoHidden,
    target: c.target,
    reasonCounts: { ...c.reasonCounts },
    reporterCount: c.reporterCount,
    qualifyingReporterCount: c.qualifyingReporterCount,
    reports: c.reports.map((r) => ({
      reporter: r.reporter,
      reason: r.reason,
      detail: r.detail,
      detailFlags: [...r.detailFlags],
      createdAt: iso(r.createdAt),
    })),
  };
}

export function caseResolutionView(r: CaseResolution) {
  return { id: r.caseId, outcome: r.outcome, effect: r.effect, productStatus: r.productStatus };
}

export function appealResolutionView(r: AppealResolution) {
  return {
    id: r.appealId,
    outcome: r.outcome,
    effect: r.effect,
    productId: r.productId,
    productStatus: r.productStatus,
  };
}

// ------------------------------------------------------------------ merchant

function couponTermsView(t: CouponTerms) {
  return {
    kind: t.kind,
    percent: t.percent,
    amountPaise: t.amountPaise === null ? null : paise(t.amountPaise),
    minSpendPaise: paise(t.minSpendPaise),
    startsAt: isoOrNull(t.startsAt),
    endsAt: isoOrNull(t.endsAt),
    maxRedemptions: t.maxRedemptions,
  };
}

export function merchantCouponView(c: MerchantCoupon) {
  return {
    id: c.couponId,
    code: c.code,
    isPublic: c.isPublic,
    status: c.status,
    ...couponTermsView(c),
    redeemed: c.redeemed,
    discountGivenPaise: paise(c.discountGivenPaise),
  };
}

export function publicCouponView(c: PublicCoupon) {
  return { code: c.code, ...couponTermsView(c) };
}

export function merchantOrderView(o: MerchantOrder) {
  return {
    // the opaque per-seller reference (0055): never the seller order's time-ordered id
    id: o.orderRef,
    orderedAt: iso(o.orderedAt),
    status: o.status,
    source: o.source,
    buyer: o.buyer,
    listPaise: paise(o.listPaise),
    discountPaise: paise(o.discountPaise),
    grossPaise: paise(o.grossPaise),
    feePaise: paise(o.feePaise),
    deliveryFeeBuyerPaise: paise(o.deliveryFeeBuyerPaise),
    deliveryFeeSellerPaise: paise(o.deliveryFeeSellerPaise),
    netPaise: paise(o.netPaise),
    // a private coupon's code could name the buyer: only public codes reach the seller (0051)
    couponCode: o.couponCode,
    couponKind: o.couponKind,
    delivery: o.delivery && {
      speed: o.delivery.speed,
      placedAt: iso(o.delivery.placedAt),
      packedAt: iso(o.delivery.packedAt),
      shippedAt: iso(o.delivery.shippedAt),
      outAt: iso(o.delivery.outAt),
      deliveredAt: iso(o.delivery.deliveredAt),
      cancelledAt: isoOrNull(o.delivery.cancelledAt),
    },
    lines: o.lines.map((l) => ({
      productId: l.productId,
      name: l.name,
      editionSerial: l.editionSerial,
      listPaise: paise(l.listPaise),
      discountPaise: paise(l.discountPaise),
      feePaise: paise(l.feePaise),
    })),
  };
}

function earningsTotalsView(t: EarningsTotals) {
  return {
    from: iso(t.from),
    to: iso(t.to),
    orders: t.orders,
    grossPaise: paise(t.grossPaise),
    feesPaise: paise(t.feesPaise),
    discountPaise: paise(t.discountPaise),
    merchantDeliveryPaise: paise(t.merchantDeliveryPaise),
    netPaise: paise(t.netPaise),
    distinctBuyers: t.distinctBuyers,
    averageOrderPaise: t.averageOrderPaise === null ? null : paise(t.averageOrderPaise),
  };
}

export function earningsView(e: Earnings) {
  return {
    periodDays: e.periodDays,
    timeZone: e.timeZone,
    asOf: iso(e.asOf),
    current: earningsTotalsView(e.current),
    previous: earningsTotalsView(e.previous),
    staff: { current: earningsTotalsView(e.staff.current), previous: earningsTotalsView(e.staff.previous) },
    daily: e.daily.map((d) => ({
      date: d.date,
      orders: d.orders,
      grossPaise: paise(d.grossPaise),
      netPaise: paise(d.netPaise),
    })),
    topProducts: e.topProducts.map((t) => ({
      productId: t.productId,
      name: t.name,
      units: t.units,
      grossPaise: paise(t.grossPaise),
    })),
  };
}

export function brandProgressView(b: BrandProgress) {
  return {
    qualifyingGrossPaise: paise(b.qualifyingGrossPaise),
    eligibleBuyers: b.eligibleBuyers,
    thresholdPaise: paise(b.thresholdPaise),
    minBuyers: b.minBuyers,
    buyerMinAgeHours: b.buyerMinAgeHours,
    grossMet: b.grossMet,
    buyersMet: b.buyersMet,
    qualifies: b.qualifies,
    tier: b.tier,
    brandUnlocked: b.brandUnlocked,
  };
}

export function inventoryView(i: Inventory) {
  return {
    lowStockThreshold: i.lowStockThreshold,
    warehouses: i.warehouses.map((w) => ({
      id: w.id,
      kind: w.kind,
      capacity: w.capacity,
      used: w.used,
      free: w.free,
      zapHub: w.zapHub,
    })),
    products: i.products.map((p) => ({
      id: p.productId,
      name: p.name,
      status: p.status,
      inventoryMode: p.inventoryMode,
      available: p.available,
      issued: p.issued,
      retired: p.retired,
      lowStock: p.lowStock,
      edition: p.edition && { supply: p.edition.supply, issued: p.edition.issued },
    })),
  };
}

/** The console's status (GET /api/v1/admin/status). */
export function adminStatusView(s: AdminStatus) {
  return {
    publication: { enabled: s.publication.enabled, updatedAt: isoOrNull(s.publication.updatedAt) },
    moderationOverdue: {
      count: s.moderationOverdue.count,
      oldestAgeSeconds: s.moderationOverdue.oldestAgeSeconds,
      oldestSubmittedAt: isoOrNull(s.moderationOverdue.oldestSubmittedAt),
      thresholdHours: s.moderationOverdue.thresholdHours,
    },
    // seventh review (0057): submissions stuck in SCREENING, reported separately
    screeningStalled: {
      count: s.screeningStalled.count,
      oldestAgeSeconds: s.screeningStalled.oldestAgeSeconds,
      oldestSubmittedAt: isoOrNull(s.screeningStalled.oldestSubmittedAt),
      thresholdHours: s.screeningStalled.thresholdHours,
    },
    needsReview: s.needsReview,
    openReportCases: s.openReportCases,
    openAppeals: s.openAppeals,
  };
}
