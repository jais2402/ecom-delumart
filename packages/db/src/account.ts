/**
 * The signed-in user's own account views (migration 0026), as app_web for the caller's sign-in
 * session. The database derives the user from the session and returns that user's rows only.
 * Money is bigint paise. Responses built from these are private (`private, no-store`).
 */
import { DomainError } from "@delulu/core";
import type { Pool } from "pg";
import { asWeb, isUuid, requireUuid } from "./command";

export interface Page<T, C> {
  items: T[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: C | null;
}

export interface Wallet {
  balancePaise: bigint;
  bankAlias: string;
  delulupayId: string;
  cardId: string | null;
  cardStatus: "ACTIVE" | "FROZEN" | null;
  cardLastFour: string | null;
  pinSet: boolean;
  creatorUnlocked: boolean;
}

export interface StatementRow {
  postingId: bigint;
  /**
   * Null, like orderGroupId, on a posting of an order the reader did not buy (a sale credited to
   * a seller, 0060); such a posting's time is rounded to the minute.
   */
  journalId: string | null;
  eventType: string;
  createdAt: Date;
  /** Signed: negative for money leaving the account. */
  amountPaise: bigint;
  balanceAfterPaise: bigint;
  orderGroupId: string | null;
  memo: string;
}

export interface OrderLine {
  orderLineId: string;
  productId: string;
  name: string;
  listPaise: bigint;
  sellerDiscountPaise: bigint;
  platformDiscountPaise: bigint;
  editionSerial: number | null;
}

export interface Shipment {
  speed: "STANDARD" | "EXPRESS" | "ZAP";
  placedAt: Date;
  packedAt: Date;
  shippedAt: Date;
  outAt: Date;
  deliveredAt: Date;
  cancelledAt: Date | null;
}

export interface SellerOrderView {
  sellerOrderId: string;
  sellerType: "USER" | "SEED";
  sellerName: string | null;
  status: "COMPLETED" | "REVERSED";
  listPaise: bigint;
  sellerDiscountPaise: bigint;
  platformDiscountPaise: bigint;
  deliveryFeePaise: bigint;
  /** What the buyer paid for this seller order. */
  totalPaise: bigint;
  shipment: Shipment | null;
  lines: OrderLine[];
}

export interface OrderView {
  orderGroupId: string;
  createdAt: Date;
  totalPaise: bigint;
  paymentReference: string;
  sellerOrders: SellerOrderView[];
}

export interface CollectionItem {
  ownershipId: string;
  productId: string;
  name: string;
  orderLineId: string;
  state: "ACTIVE" | "REVOKED" | "UNAVAILABLE";
  acquiredAt: Date;
}

function pageSize(n: number | undefined): number | null {
  if (n === undefined) return null;
  if (!Number.isSafeInteger(n) || n < 1)
    throw new DomainError("VALIDATION_FAILED", "page size is at least 1");
  return n;
}

/** Balance, bank alias, DeluluPay id and card summary; null before provisioning. */
export async function myWallet(pool: Pool, input: { authSessionId: string }): Promise<Wallet | null> {
  return asWeb(pool, input.authSessionId, async (c) => {
    const { rows } = await c.query<{
      balance_paise: string;
      bank_alias: string;
      delulupay_id: string;
      card_id: string | null;
      card_status: "ACTIVE" | "FROZEN" | null;
      card_last_four: string | null;
      pin_set: boolean | null;
      creator_unlocked: boolean;
    }>(
      "SELECT balance_paise::text AS balance_paise, bank_alias, delulupay_id, card_id, card_status, card_last_four, pin_set, creator_unlocked FROM core.my_wallet()",
    );
    const r = rows[0];
    if (!r) return null;
    return {
      balancePaise: BigInt(r.balance_paise),
      bankAlias: r.bank_alias,
      delulupayId: r.delulupay_id,
      cardId: r.card_id,
      cardStatus: r.card_status,
      cardLastFour: r.card_last_four,
      pinSet: r.pin_set === true,
      creatorUnlocked: r.creator_unlocked,
    };
  });
}

/** The full card number of the caller's own card; needs a sign-in within five minutes (REAUTH_REQUIRED). */
export async function revealCardNumber(
  pool: Pool,
  input: { authSessionId: string; cardId: string },
): Promise<string> {
  requireUuid(input.cardId, "cardId");
  return asWeb(pool, input.authSessionId, async (c) => {
    const { rows } = await c.query<{ n: string }>("SELECT core.reveal_card_number($1) AS n", [input.cardId]);
    const n = rows[0]?.n;
    if (!n) throw new Error("reveal_card_number returned nothing");
    return n;
  });
}

/** Own postings, newest first, with the balance after each. At most 50 per page. */
export async function myStatement(
  pool: Pool,
  input: { authSessionId: string; cursor?: bigint | null; pageSize?: number },
): Promise<Page<StatementRow, bigint>> {
  const size = pageSize(input.pageSize);
  return asWeb(pool, input.authSessionId, async (c) => {
    const { rows } = await c.query<{
      posting_id: string;
      journal_id: string | null;
      event_type: string;
      created_at: Date;
      amount_paise: string;
      balance_after_paise: string;
      order_group_id: string | null;
      memo: string;
      max: number;
    }>(
      `SELECT posting_id::text, journal_id, event_type, created_at, amount_paise::text, balance_after_paise::text,
              order_group_id, memo, core.page_size($2) AS max
         FROM core.my_statement($1, $2)`,
      [input.cursor == null ? null : input.cursor.toString(), size],
    );
    const items = rows.map((r) => ({
      postingId: BigInt(r.posting_id),
      journalId: r.journal_id,
      eventType: r.event_type,
      createdAt: r.created_at,
      amountPaise: BigInt(r.amount_paise),
      balanceAfterPaise: BigInt(r.balance_after_paise),
      orderGroupId: r.order_group_id,
      memo: r.memo,
    }));
    const last = items.at(-1);
    const full = rows.length > 0 && rows.length === rows[0]?.max;
    return { items, nextCursor: full && last ? last.postingId : null };
  });
}

interface StoredSellerOrder {
  sellerOrderId: string;
  sellerType: "USER" | "SEED";
  sellerName: string | null;
  status: "COMPLETED" | "REVERSED";
  listPaise: string;
  sellerDiscountPaise: string;
  platformDiscountPaise: string;
  deliveryFeePaise: string;
  totalPaise: string;
  shipment: {
    speed: Shipment["speed"];
    placedAt: string;
    packedAt: string;
    shippedAt: string;
    outAt: string;
    deliveredAt: string;
    cancelledAt: string | null;
  } | null;
  lines: {
    orderLineId: string;
    productId: string;
    name: string;
    listPaise: string;
    sellerDiscountPaise: string;
    platformDiscountPaise: string;
    editionSerial: number | null;
  }[];
}

interface OrderRow {
  order_group_id: string;
  created_at: Date;
  total_paise: string;
  payment_reference: string;
  seller_orders: StoredSellerOrder[];
}

const ORDER_COLUMNS =
  "order_group_id, created_at, total_paise::text AS total_paise, payment_reference, seller_orders";

function orderOf(r: OrderRow): OrderView {
  return {
    orderGroupId: r.order_group_id,
    createdAt: r.created_at,
    totalPaise: BigInt(r.total_paise),
    paymentReference: r.payment_reference,
    sellerOrders: r.seller_orders.map((so) => ({
      sellerOrderId: so.sellerOrderId,
      sellerType: so.sellerType,
      sellerName: so.sellerName,
      status: so.status,
      listPaise: BigInt(so.listPaise),
      sellerDiscountPaise: BigInt(so.sellerDiscountPaise),
      platformDiscountPaise: BigInt(so.platformDiscountPaise),
      deliveryFeePaise: BigInt(so.deliveryFeePaise),
      totalPaise: BigInt(so.totalPaise),
      shipment: so.shipment && {
        speed: so.shipment.speed,
        placedAt: new Date(so.shipment.placedAt),
        packedAt: new Date(so.shipment.packedAt),
        shippedAt: new Date(so.shipment.shippedAt),
        outAt: new Date(so.shipment.outAt),
        deliveredAt: new Date(so.shipment.deliveredAt),
        cancelledAt: so.shipment.cancelledAt === null ? null : new Date(so.shipment.cancelledAt),
      },
      lines: so.lines.map((l) => ({
        orderLineId: l.orderLineId,
        productId: l.productId,
        name: l.name,
        listPaise: BigInt(l.listPaise),
        sellerDiscountPaise: BigInt(l.sellerDiscountPaise),
        platformDiscountPaise: BigInt(l.platformDiscountPaise),
        editionSerial: l.editionSerial,
      })),
    })),
  };
}

/** Own order groups, newest first (cursor: the last orderGroupId seen). At most 50 per page. */
export async function myOrders(
  pool: Pool,
  input: { authSessionId: string; cursor?: string | null; pageSize?: number },
): Promise<Page<OrderView, string>> {
  if (input.cursor != null) requireUuid(input.cursor, "cursor");
  const size = pageSize(input.pageSize);
  return asWeb(pool, input.authSessionId, async (c) => {
    const { rows } = await c.query<OrderRow & { max: number }>(
      `SELECT ${ORDER_COLUMNS}, core.page_size($2) AS max FROM core.my_orders($1, $2)`,
      [input.cursor ?? null, size],
    );
    const items = rows.map(orderOf);
    const full = rows.length > 0 && rows.length === rows[0]?.max;
    return { items, nextCursor: full ? (items.at(-1)?.orderGroupId ?? null) : null };
  });
}

/** One own order group, or null (also for someone else's). */
export async function myOrder(
  pool: Pool,
  input: { authSessionId: string; orderGroupId: string },
): Promise<OrderView | null> {
  if (!isUuid(input.orderGroupId)) return null;
  return asWeb(pool, input.authSessionId, async (c) => {
    const { rows } = await c.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM core.my_order($1)`, [
      input.orderGroupId,
    ]);
    return rows[0] ? orderOf(rows[0]) : null;
  });
}

/** Own ownerships, newest first. */
export async function myCollection(pool: Pool, input: { authSessionId: string }): Promise<CollectionItem[]> {
  return asWeb(pool, input.authSessionId, async (c) => {
    const { rows } = await c.query<{
      ownership_id: string;
      product_id: string;
      name: string;
      order_line_id: string;
      state: CollectionItem["state"];
      acquired_at: Date;
    }>("SELECT * FROM core.my_collection()");
    return rows.map((r) => ({
      ownershipId: r.ownership_id,
      productId: r.product_id,
      name: r.name,
      orderLineId: r.order_line_id,
      state: r.state,
      acquiredAt: r.acquired_at,
    }));
  });
}

/** Which of these products (at most 100) the caller already owns, for the "owned" badge. */
export async function ownsProducts(
  pool: Pool,
  input: { authSessionId: string; productIds: readonly string[] },
): Promise<Set<string>> {
  for (const id of input.productIds) requireUuid(id, "productId");
  if (input.productIds.length > 100)
    throw new DomainError("VALIDATION_FAILED", "ask about at most 100 products");
  if (input.productIds.length === 0) return new Set();
  return asWeb(pool, input.authSessionId, async (c) => {
    const { rows } = await c.query<{ product_id: string }>(
      "SELECT product_id FROM core.owns_products($1::uuid[])",
      [[...input.productIds]],
    );
    return new Set(rows.map((r) => r.product_id));
  });
}
