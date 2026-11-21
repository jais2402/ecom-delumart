"use client";

import { LoadingBlock } from "../../_components/LoadState";
import { OrderDetail } from "../../_components/OrderDetail";
import { ShopShell } from "../../_components/ShopShell";
import { wasJustPaid } from "../../_lib/checkout-context";
import { useRequireAccount } from "../../_lib/use-require-account";

/** Private: signed-out visitors are sent to /sign-in; the order is fetched in the browser. */
export function OrderPage({ id }: { id: string }) {
  const { ok } = useRequireAccount();
  return (
    <ShopShell>
      {ok ? (
        <OrderDetail id={id} justPaid={wasJustPaid(id)} />
      ) : (
        <LoadingBlock label="Checking your sign-in" />
      )}
    </ShopShell>
  );
}
