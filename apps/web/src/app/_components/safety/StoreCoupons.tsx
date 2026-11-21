"use client";

import { CopyCode, FictionLabel, Heading, Text } from "@delulu/ui";
import { useEffect, useState } from "react";
import { api } from "../../_lib/api";
import { describeCoupon, type PublicCoupon } from "../../_lib/merchant";

/** The shop's public coupons, read in the browser from the public coupons route. */
export function StoreCoupons({ handle }: { handle: string }) {
  const [coupons, setCoupons] = useState<PublicCoupon[]>([]);
  useEffect(() => {
    let cancelled = false;
    api<{ items: PublicCoupon[] }>(`/api/v1/stores/${handle}/coupons`)
      .then((r) => {
        if (!cancelled) setCoupons(r.items);
      })
      .catch(() => {
        // coupons are an extra: the shop page works without them
      });
    return () => {
      cancelled = true;
    };
  }, [handle]);
  if (coupons.length === 0) return null;
  return (
    <section aria-labelledby="shop-coupons" className="flex flex-col gap-3">
      <Heading level={2} size="md" id="shop-coupons">
        Coupons from this shop
      </Heading>
      <Text size="sm" muted>
        Enter a code in your cart to use it. <FictionLabel>Fictional money</FictionLabel>
      </Text>
      <ul aria-label="Shop coupons" className="grid gap-3 min-[480px]:grid-cols-2">
        {coupons.map((c) => (
          <li key={c.code} className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
            <CopyCode code={c.code} noun="coupon code" />
            <ul className="list-disc pl-5 text-sm text-fg">
              {describeCoupon(c).map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
