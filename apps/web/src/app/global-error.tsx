"use client";

import { Button, RecoveryPanel } from "@delulu/ui";
import { CATEGORY_LINKS } from "./_lib/category-style";
import "./globals.css";

/**
 * The last resort: the root layout itself failed, so there is no shop header or footer to draw.
 * It stays in the storefront's look with the same panel, but needs nothing from the app to render
 * (search is a plain GET form that works as a link).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="bg-bg font-body text-fg">
        <main className="px-4 py-8 md:py-12">
          <RecoveryPanel
            title="Something went wrong"
            message="DeluluMart could not load. Nothing was lost and no fictional money moved. Try again in a moment."
            {...(error.digest ? { detail: `Reference: ${error.digest}` } : {})}
            action={<Button onClick={reset}>Try again</Button>}
            searchAction="/search"
            onSearch={(query) => {
              window.location.assign(query ? `/search?q=${encodeURIComponent(query)}` : "/search");
            }}
            categories={CATEGORY_LINKS}
          />
        </main>
      </body>
    </html>
  );
}
