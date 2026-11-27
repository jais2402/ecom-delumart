import { Heading, Text } from "@delulu/ui";
import type { Metadata } from "next";
import { HelpArticle } from "../_components/help/HelpArticle";
import { ShopShell } from "../_components/ShopShell";

export const metadata: Metadata = {
  title: "Help centre",
  description: "How fictional money, delivery, payments, selling, reviews and privacy work on DeluluMart.",
};

/** Public and the same for everyone. */
export default function Page() {
  return (
    <ShopShell>
      <div className="flex flex-col gap-4 md:gap-6">
        <header className="rounded-lg bg-surface p-5 md:p-6">
          <Heading level={1} size="xl">
            Help centre
          </Heading>
          <Text muted className="mt-1 max-w-reading">
            How DeluluMart works, from your first purchase to opening a shop.
          </Text>
        </header>
        <HelpArticle />
      </div>
    </ShopShell>
  );
}
