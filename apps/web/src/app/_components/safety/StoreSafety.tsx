"use client";

import { Alert, Text } from "@delulu/ui";
import type { ReactNode } from "react";
import { useBlockedSellerKeys } from "../../_lib/blocks-store";
import { BLOCK_EXPLANATION, BlockShopButton } from "./BlockShop";
import { ReportButton } from "./ReportButton";

/** Report and block for a shop page. The company id comes from the shop's products; a shop with none has no id to act on. */
export function StoreSafety({
  companyId,
  handle,
  shopName,
}: {
  companyId: string | null;
  handle: string;
  shopName: string;
}) {
  if (!companyId) return null;
  const returnTo = `/store/${handle}`;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-start gap-2">
        <ReportButton
          targetType="STORE"
          targetId={companyId}
          targetName={`the shop ${shopName}`}
          returnTo={returnTo}
          label="Report this shop"
        />
        <BlockShopButton companyId={companyId} shopName={shopName} returnTo={returnTo} />
      </div>
      <Text size="sm" muted>
        {BLOCK_EXPLANATION}
      </Text>
    </div>
  );
}

/** Replaces its children with a notice when the viewer blocked this shop. The children are the same public HTML for everyone. */
export function HideWhenBlocked({ companyId, children }: { companyId: string | null; children: ReactNode }) {
  const blocked = useBlockedSellerKeys();
  if (companyId && blocked.has(companyId)) {
    return (
      <Alert tone="info" title="You blocked this shop">
        Its products are hidden for you. Use "Unblock this shop" above to see them again.
      </Alert>
    );
  }
  return children;
}
