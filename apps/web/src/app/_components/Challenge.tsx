"use client";

import { useEffect, useId, useRef, useState } from "react";

/**
 * Cloudflare Turnstile (ninth review, major 2a): the security check on email sign-in, the email
 * code and the phone step. The page passes the PUBLIC site key (null: this deployment asks for no
 * check, and nothing renders). The widget's script comes from challenges.cloudflare.com, allowed
 * by the Content-Security-Policy of these pages only (script-src and frame-src for that origin);
 * the page's own nonced scripts add it, which 'strict-dynamic' trusts.
 *
 * Each token is good for ONE request: after every submission the page bumps `generation`, the
 * widget resets and `onToken(null)` is called until a new token arrives. The token is kept in
 * memory only and sent with the request; the server checks it with Cloudflare.
 */
export type ChallengeAction = "email_start" | "email_verify" | "phone_code";

interface TurnstileOptions {
  sitekey: string;
  action: ChallengeAction;
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": () => void;
  theme: "auto";
  size: "flexible";
  language: "auto";
}

interface TurnstileApi {
  render(element: HTMLElement, options: TurnstileOptions): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptLoad: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptLoad ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("no turnstile")));
    script.onerror = () => {
      scriptLoad = null;
      reject(new Error("turnstile did not load"));
    };
    document.head.appendChild(script);
  });
  return scriptLoad;
}

export function Challenge({
  siteKey,
  action,
  onToken,
  generation,
}: {
  siteKey: string | null;
  action: ChallengeAction;
  onToken: (token: string | null) => void;
  /** Bump after each use of a token: the widget resets for a fresh one. */
  generation: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const tokenCallback = useRef(onToken);
  tokenCallback.current = onToken;
  const [failed, setFailed] = useState(false);
  const hintId = useId();

  useEffect(() => {
    if (siteKey === null) return;
    let cancelled = false;
    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || container.current === null || widget.current !== null) return;
        widget.current = turnstile.render(container.current, {
          sitekey: siteKey,
          action,
          callback: (token) => tokenCallback.current(token),
          "expired-callback": () => tokenCallback.current(null),
          "error-callback": () => tokenCallback.current(null),
          theme: "auto",
          size: "flexible",
          language: "auto",
        });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (widget.current !== null) window.turnstile?.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey, action]);

  useEffect(() => {
    if (generation === 0 || widget.current === null) return;
    tokenCallback.current(null);
    window.turnstile?.reset(widget.current);
  }, [generation]);

  if (siteKey === null) return null;
  return (
    <section aria-label="Security check" aria-describedby={hintId} className="flex flex-col gap-2">
      <p id={hintId} className="text-sm text-fg-muted">
        {failed
          ? "The security check could not load. Check your connection, then reload this page."
          : "A quick security check from Cloudflare confirms you are a person. It usually completes on its own."}
      </p>
      <div ref={container} />
    </section>
  );
}
