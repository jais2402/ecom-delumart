import { formatInrCompact, STARTING_GRANT_PAISE } from "@delulu/core";
import {
  CategoryThumbs,
  CreatorBand,
  FeatureRail,
  HomeHero,
  HomeLayout,
  HowItWorks,
  LockIcon,
  PackageIcon,
  PromoTile,
  ShieldCheckIcon,
  TruckIcon,
  TrustStrip,
} from "@delulu/ui";
import type { Metadata } from "next";
import { CATEGORIES } from "../data/seed-catalog";
import { HomeRails } from "./_components/HomeRails";
import { ShopShell } from "./_components/ShopShell";
import { loadCatalog } from "./_lib/catalog-server";
import { CATEGORY_LINKS, motifOfCategory } from "./_lib/category-style";
import { deriveHomeRails, lowestPriceOf, representativeOf } from "./_lib/home-rails";
import { parsePaise } from "./_lib/money";
import { photoSrcOf } from "./_lib/product-photos";
import { arrivalPhrase } from "./_lib/speeds";

export const metadata: Metadata = { title: "Buy things that don't exist" };

/** Categories shown as picture tiles beside the hero's colour block. */
const HERO_TILE_CATEGORIES = ["impossible-tech", "cosmic-collectibles", "food-fantasies"] as const;
/** Hue of the generated art when a category has no product to stand for it. */
const FALLBACK_HUE = 265;

const TRUST = [
  { icon: TruckIcon, title: "Delivery in minutes", text: `Zap delivery arrives in ${arrivalPhrase("ZAP")}.` },
  { icon: PackageIcon, title: "Independent shops", text: "Creators sell beside DeluluMart Originals." },
  { icon: LockIcon, title: "Secure checkout", text: "Every payment is confirmed with your PIN." },
  { icon: ShieldCheckIcon, title: "Private by design", text: "Sellers never see your delivery address." },
] as const;

const GRANT = formatInrCompact(STARTING_GRANT_PAISE);

const STEPS = [
  { title: "Create your account", text: `Sign up and a ${GRANT} welcome balance is added to your wallet.` },
  {
    title: "Choose and pay",
    text: "Add products to your cart and pay with your card or bank balance, confirmed with your PIN.",
  },
  { title: "Track your delivery", text: "Pick Standard, Express or Zap and follow your order to the door." },
] as const;

/** Public page; it never contains anything about a signed-in person (rendered per request for the CSP nonce). */
export default async function HomePage() {
  const catalog = await loadCatalog();
  const rails = deriveHomeRails(catalog, CATEGORIES);
  // the dearest products, those with a photo first so the large cards are pictures where possible
  const dearest = rails.find((rail) => rail.key === "big-flex")?.products ?? [];
  const featured = [
    ...dearest.filter((product) => photoSrcOf(product) !== undefined),
    ...dearest.filter((product) => photoSrcOf(product) === undefined),
  ].slice(0, 3);

  // a category is pictured by a product that has a photo when it has one, else by its first product
  const withPhotos = catalog.filter((product) => photoSrcOf(product) !== undefined);
  const standFor = (slug: string) => representativeOf(withPhotos, slug) ?? representativeOf(catalog, slug);
  const thumbs = CATEGORY_LINKS.map((category) => {
    const stand = standFor(category.slug);
    return {
      ...category,
      hue: stand?.templateId ?? FALLBACK_HUE,
      seed: stand?.name ?? category.slug,
      imageSrc: stand ? photoSrcOf(stand) : undefined,
    };
  });
  const tiles = HERO_TILE_CATEGORIES.flatMap((slug) => {
    const category = CATEGORY_LINKS.find((entry) => entry.slug === slug);
    if (!category) return [];
    const stand = standFor(slug);
    const lowest = lowestPriceOf(catalog, slug);
    return [
      {
        href: category.href,
        caption: category.name,
        ...(lowest !== undefined ? { detail: `From ${formatInrCompact(lowest)}` } : {}),
        hue: stand?.templateId ?? FALLBACK_HUE,
        seed: stand?.name ?? slug,
        motif: motifOfCategory(slug),
        imageSrc: stand ? photoSrcOf(stand) : undefined,
      },
    ];
  });

  return (
    <ShopShell>
      <HomeLayout
        categories={<CategoryThumbs categories={thumbs} />}
        hero={
          <HomeHero
            title={`${GRANT} welcome balance for every new account.`}
            text="Create an account, pick something from the catalogue and have it on its way in minutes."
            action={{ label: "Start shopping", href: "#featured" }}
            tiles={tiles}
          />
        }
        featured={
          <FeatureRail
            title="In focus."
            lead="Our priciest products."
            items={featured.map((product) => ({
              id: product.id,
              href: `/p/${product.id}`,
              name: product.name,
              hook: product.hook ?? "",
              pricePaise: parsePaise(product.pricePaise),
              hue: product.templateId,
              motif: motifOfCategory(product.category),
              imageSrc: photoSrcOf(product),
            }))}
          />
        }
        promos={
          <>
            <PromoTile
              tone="warm"
              title="Sell on DeluluMart"
              text="Open a shop, list your products and reach every shopper on the site."
              cta={{ label: "Open a shop", href: "/sell" }}
              art={{ hue: 20, seed: "promo-cone", motif: "food" }}
            />
            <PromoTile
              tone="brand"
              title="Delivery in minutes with Zap"
              text={`Choose Zap at checkout on eligible products and get your order in ${arrivalPhrase("ZAP")}.`}
              cta={{ label: "How delivery works", href: "#how-it-works" }}
              art={{ hue: 150, seed: "promo-gadget", motif: "tech" }}
            />
          </>
        }
        trust={<TrustStrip items={TRUST} label="Good to know" />}
        steps={<HowItWorks title="How shopping works." lead="Three steps." steps={STEPS} />}
        creator={
          <CreatorBand
            title="Got something to sell?"
            text="Open a shop on DeluluMart, list your products and start earning."
            cta={{ label: "Start selling", href: "/sell" }}
          />
        }
      >
        <HomeRails rails={rails} />
      </HomeLayout>
    </ShopShell>
  );
}
