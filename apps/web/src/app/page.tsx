import { FictionLabel, Heading, Text } from "@delulu/ui";
import type { Metadata } from "next";
import { CATEGORIES } from "../data/seed-catalog";
import { FeaturedProducts } from "./_components/FeaturedProducts";
import { ShopShell } from "./_components/ShopShell";
import { featuredAcrossPrices } from "./_lib/catalog";
import { loadCatalog } from "./_lib/catalog-server";

export const metadata: Metadata = { title: "Buy things that don't exist" };

/** Public page, rebuilt at most once a minute; it never contains anything about a signed-in person. */
export const revalidate = 60;

export default async function HomePage() {
  const featured = featuredAcrossPrices(
    await loadCatalog(),
    CATEGORIES.map((c) => c.slug),
  );

  return (
    <ShopShell>
      <section className="flex flex-col items-start gap-3 rounded-lg bg-action-soft p-6">
        <FictionLabel>Fictional money · nothing real ships</FictionLabel>
        <Heading level={1} size="xl" className="max-w-reading">
          Start with ₹100 crore. Buy things that don&apos;t exist.
        </Heading>
        <Text muted className="max-w-reading">
          DeluluMart is a pretend department store. Spend game money on impossible objects and watch simulated
          couriers deliver them.
        </Text>
      </section>

      <nav aria-label="Categories" className="mt-8">
        <Heading level={2} size="md" className="mb-3">
          Shop by category
        </Heading>
        <ul className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 md:grid-cols-3">
          {CATEGORIES.map((category) => (
            <li key={category.slug}>
              <a
                href={`/c/${category.slug}`}
                className="flex h-full min-h-touch flex-col gap-1 rounded-lg border border-border bg-surface p-4 hover:border-action"
              >
                <span className="font-display text-lg font-bold text-fg">{category.name}</span>
                <span className="text-sm text-fg-muted">{category.blurb}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <section className="mt-8" aria-labelledby="featured">
        <Heading level={2} size="md" id="featured" className="mb-3">
          Fresh impossibilities
        </Heading>
        <FeaturedProducts initial={featured} />
      </section>
    </ShopShell>
  );
}
