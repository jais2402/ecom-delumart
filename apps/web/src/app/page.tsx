import { formatInrCompact, STARTING_GRANT_PAISE } from "@delulu/core";
import {
  BrandStory,
  CategoryThumbs,
  CreatorBand,
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
import { storeNameOf } from "./_lib/catalog";
import { loadCatalog } from "./_lib/catalog-server";
import { CATEGORY_LINKS, motifOfCategory } from "./_lib/category-style";
import { deriveHomeRails, deriveTopPicks, pickHeroProducts, representativeOf } from "./_lib/home-rails";
import { parsePaise } from "./_lib/money";
import { photoSrcOf } from "./_lib/product-photos";
import { arrivalPhrase } from "./_lib/speeds";

export const metadata: Metadata = { title: "Buy things that don't exist" };

/** Hue of the generated art when a category has no product to stand for it. */
const FALLBACK_HUE = 265;

const TRUST = [
  { icon: TruckIcon, title: "Delivery in minutes", text: `Zap arrives in ${arrivalPhrase("ZAP")}.` },
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
  const heroProducts = pickHeroProducts(catalog);
  const topPicks = deriveTopPicks(catalog, CATEGORIES);
  const rails = deriveHomeRails(catalog, new Set(heroProducts.map((product) => product.id)));

  // a category is pictured by a product that has a photo when it has one, else by its first product
  const withPhotos = catalog.filter((product) => photoSrcOf(product) !== undefined);
  const thumbs = CATEGORY_LINKS.map((category) => {
    const stand = representativeOf(withPhotos, category.slug) ?? representativeOf(catalog, category.slug);
    return {
      ...category,
      hue: stand?.templateId ?? FALLBACK_HUE,
      seed: stand?.name ?? category.slug,
      imageSrc: stand ? photoSrcOf(stand) : undefined,
    };
  });

  // figures counted from the catalogue response this page already has; none when it is empty
  const shops = new Set(catalog.map(storeNameOf)).size;
  const stats =
    catalog.length === 0
      ? []
      : [
          { label: "Products", value: String(catalog.length) },
          { label: "Categories", value: String(new Set(catalog.map((product) => product.category)).size) },
          { label: shops === 1 ? "Shop" : "Shops", value: String(shops) },
        ];

  return (
    <ShopShell>
      <HomeLayout
        hero={
          <HomeHero
            title={`${GRANT} welcome balance for every new account.`}
            text="Create an account, pick something from the catalogue and have it on its way in minutes."
            slides={heroProducts.map((product) => ({
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
        promises={<TrustStrip items={TRUST} label="Good to know" />}
        categories={<CategoryThumbs categories={thumbs} />}
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
        story={
          <BrandStory
            title="Shop the whole range in one place."
            text="DeluluMart brings DeluluMart Originals and independent creator shops into one catalogue. Browse by category, choose Standard, Express or Zap delivery at checkout and confirm every payment with your PIN. Sellers never see your delivery address."
            stats={stats}
          />
        }
        steps={<HowItWorks title="How shopping works." lead="Three steps." steps={STEPS} />}
        creator={
          <CreatorBand
            title="Got something to sell?"
            text="Open a shop on DeluluMart, list your products and start earning."
            cta={{ label: "Start selling", href: "/sell" }}
          />
        }
      >
        <HomeRails topPicks={topPicks} rails={rails} />
      </HomeLayout>
    </ShopShell>
  );
}
