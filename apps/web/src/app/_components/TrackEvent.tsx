"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import {
  type ClientEventName,
  type ClientEventProps,
  type ClientSurface,
  trackClient,
} from "../_lib/analytics";

/** Sends one analytics event when it mounts (and again only if its event changes). Renders nothing. */
export function TrackEvent<N extends ClientEventName>({
  name,
  props,
  surface = "shop",
}: {
  name: N;
  props: ClientEventProps[N];
  surface?: ClientSurface;
}) {
  const signature = JSON.stringify([name, props, surface]);
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (sent.current === signature) return; // once per event, also under StrictMode's double effects
    sent.current = signature;
    const [n, p, s] = JSON.parse(signature) as [N, ClientEventProps[N], ClientSurface];
    trackClient(n, p, s);
  }, [signature]);
  return null;
}

/** A page_view for every client-side navigation within a layout. Renders nothing. */
export function PageViewTracker({ surface = "shop" }: { surface?: ClientSurface }) {
  const pathname = usePathname();
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (sent.current === pathname) return;
    sent.current = pathname;
    trackClient("page_view", {}, surface);
  }, [pathname, surface]);
  return null;
}
