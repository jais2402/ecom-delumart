import { FictionLabel, Heading, ProductGrid, Text } from "@delulu/ui";
import type { Metadata } from "next";
import { CATEGORIES, SEED_PRODUCTS } from "../data/seed-catalog";
import { ShopShell } from "./_components/ShopShell";
import { toGridItem } from "./_lib/catalog";

export const metadata: Metadata = { title: "Buy things that don't exist" };

export default function HomePage() {
  const featured = CATEGORIES.flatMap((category) =>
    SEED_PRODUCTS.filter((product) => product.category === category.slug).slice(0, 2),
  ).map(toGridItem);

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
        <ProductGrid items={featured} label="Featured products" />
      </section>
    </ShopShell>
  );
}
