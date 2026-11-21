"use client";

import { OverflowMenu } from "@delulu/ui";
import { useBlockShop } from "./BlockShop";
import { ReportButton } from "./ReportButton";

/** Report, and an overflow menu holding "Block this shop", for a product page. */
export function ProductSafetyActions({
  productId,
  productName,
  companyId,
  shopName,
}: {
  productId: string;
  productName: string;
  /** The seller's company id; null for platform products, which cannot be blocked. */
  companyId: string | null;
  shopName: string;
}) {
  const returnTo = `/p/${productId}`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ReportButton
        targetType="PRODUCT"
        targetId={productId}
        targetName={productName}
        returnTo={returnTo}
        label="Report this product"
      />
      {companyId ? <BlockInMenu companyId={companyId} shopName={shopName} returnTo={returnTo} /> : null}
    </div>
  );
}

function BlockInMenu({
  companyId,
  shopName,
  returnTo,
}: {
  companyId: string;
  shopName: string;
  returnTo: string;
}) {
  const { blocked, start, dialog, status } = useBlockShop({ companyId, shopName, returnTo });
  return (
    <>
      <OverflowMenu items={[{ label: blocked ? "Unblock this shop" : "Block this shop", onSelect: start }]} />
      {status}
      {dialog}
    </>
  );
}
