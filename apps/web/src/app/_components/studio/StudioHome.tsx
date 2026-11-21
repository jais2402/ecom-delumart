"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { ListingPage } from "../../_lib/studio";
import { useApiGet } from "../../_lib/use-api";
import { ErrorBlock, LoadingBlock } from "../LoadState";

/** /studio: the overview once the shop has a listing, the product list while it has none. */
export function StudioHome() {
  const router = useRouter();
  const loaded = useApiGet<ListingPage>("/api/v1/studio/products?limit=1");
  useEffect(() => {
    if (loaded.status === "ready") {
      router.replace(loaded.data.items.length > 0 ? "/studio/overview" : "/studio/products");
    }
  }, [loaded, router]);
  if (loaded.status === "error") return <ErrorBlock message={loaded.message} onRetry={loaded.reload} />;
  return <LoadingBlock rows={3} label="Opening your portal" />;
}
