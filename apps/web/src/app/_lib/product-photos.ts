import { SEED_PRODUCTS } from "../../data/seed-catalog";
import type { ProductResponse } from "./api";

/**
 * Photos of platform seed products, by seed id: the file name under /public/products. Photos are
 * served from our own origin (never hot-linked); credits are in public/products/CREDITS.md. A
 * product with no entry keeps its generated art, and so does every player listing.
 */
export const PRODUCT_PHOTOS: Readonly<Record<string, string>> = {
  "asteroid-named-after-your-cat": "asteroid-named-after-your-cat.webp",
  "biryani-scented-hot-air-balloon": "biryani-scented-hot-air-balloon.webp",
  "bottle-of-starlight-from-last-tuesday": "bottle-of-starlight-from-last-tuesday.webp",
  "breakfast-that-cooks-itself-on-the-commute": "breakfast-that-cooks-itself-on-the-commute.webp",
  "chai-that-tastes-like-your-childhood-monsoon": "chai-that-tastes-like-your-childhood-monsoon.webp",
  "cricket-match-you-watched-in-a-dream": "cricket-match-you-watched-in-a-dream.webp",
  "diamond-kite-that-lifts-a-bungalow": "diamond-kite-that-lifts-a-bungalow.webp",
  "dosa-large-enough-to-cover-a-cricket-pitch": "dosa-large-enough-to-cover-a-cricket-pitch.webp",
  "festival-night-lasting-three-minutes-longer": "festival-night-lasting-three-minutes-longer.webp",
  "front-door-key-that-never-gets-lost": "front-door-key-that-never-gets-lost.webp",
  "front-row-seat-at-a-concert-played-by-ceiling-fans":
    "front-row-seat-at-a-concert-played-by-ceiling-fans.webp",
  "gold-plated-chai-strainer": "gold-plated-chai-strainer.webp",
  "golden-laddoo-mountain": "golden-laddoo-mountain.webp",
  "gravity-optional-ceiling-fan": "gravity-optional-ceiling-fan.webp",
  "hill-station-that-never-opens-on-time": "hill-station-that-never-opens-on-time.webp",
  "holiday-to-a-country-not-yet-invented": "holiday-to-a-country-not-yet-invented.webp",
  "infinite-pani-puri-vending-machine": "infinite-pani-puri-vending-machine.webp",
  "internet-that-only-works-on-tuesdays": "internet-that-only-works-on-tuesdays.webp",
  "kitchen-clock-that-stops-for-chai": "kitchen-clock-that-stops-for-chai.webp",
  "lamp-that-glows-when-nobody-is-looking": "lamp-that-glows-when-nobody-is-looking.webp",
  "left-sock-finder": "left-sock-finder.webp",
  "lifetime-pass-to-every-train-that-never-left": "lifetime-pass-to-every-train-that-never-left.webp",
  "limousine-pulled-by-eleven-swans": "limousine-pulled-by-eleven-swans.webp",
  "machine-that-invents-next-years-weather": "machine-that-invents-next-years-weather.webp",
  "magic-carpet-ride-through-one-ordinary-morning": "magic-carpet-ride-through-one-ordinary-morning.webp",
  "mango-season-in-a-teaspoon": "mango-season-in-a-teaspoon.webp",
  "mini-galaxy-in-a-teacup": "mini-galaxy-in-a-teacup.webp",
  "monsoon-in-a-jar": "monsoon-in-a-jar.webp",
  "moon-crater-snow-globe": "moon-crater-snow-globe.webp",
  "nebula-scarf-for-chilly-evenings": "nebula-scarf-for-chilly-evenings.webp",
  "penthouse-floating-above-a-raindrop": "penthouse-floating-above-a-raindrop.webp",
  "pocket-comet-with-friendly-tail": "pocket-comet-with-friendly-tail.webp",
  "pocket-solar-system-starter-kit": "pocket-solar-system-starter-kit.webp",
  "pocket-umbrella-that-stays-dry-forever": "pocket-umbrella-that-stays-dry-forever.webp",
  "private-island-shaped-like-a-samosa": "private-island-shaped-like-a-samosa.webp",
  "private-planet-with-two-moons-and-a-fridge": "private-planet-with-two-moons-and-a-fridge.webp",
  "restaurant-where-only-the-dessert-is-real": "restaurant-where-only-the-dessert-is-real.webp",
  "royal-elephant-shaped-yacht": "royal-elephant-shaped-yacht.webp",
  "samosa-that-has-never-been-cold": "samosa-that-has-never-been-cold.webp",
  "self-folding-laundry-basket": "self-folding-laundry-basket.webp",
  "self-watering-cactus-with-opinions": "self-watering-cactus-with-opinions.webp",
  "seven-season-holiday-in-one-lunch-break": "seven-season-holiday-in-one-lunch-break.webp",
  "solar-flare-lamp-with-dimmer-switch": "solar-flare-lamp-with-dimmer-switch.webp",
  "sunrise-ride-on-a-monsoon-cloud": "sunrise-ride-on-a-monsoon-cloud.webp",
  "teleporting-tiffin-box": "teleporting-tiffin-box.webp",
  "time-zone-shifting-wall-clock": "time-zone-shifting-wall-clock.webp",
  "train-window-seat-with-a-view-of-yesterday": "train-window-seat-with-a-view-of-yesterday.webp",
  "velvet-rope-for-a-pigeon": "velvet-rope-for-a-pigeon.webp",
  "wardrobe-that-reorganises-itself-by-mood": "wardrobe-that-reorganises-itself-by-mood.webp",
  "weather-forecast-that-argues-back": "weather-forecast-that-argues-back.webp",
};

const SEED_ID_BY_NAME: ReadonlyMap<string, string> = new Map(
  SEED_PRODUCTS.map((seed) => [seed.name, seed.id]),
);

/** Platform stock only: a creator's listing may reuse a seed product's name but never gets its photo. */
function isPlatformSeed(product: Pick<ProductResponse, "sellerKey" | "sellerName">): boolean {
  return product.sellerKey === "SEED" || (product.sellerKey === undefined && product.sellerName === null);
}

/** The same-origin photo path for a product, or undefined when it has none. */
export function photoSrcOf(
  product: Pick<ProductResponse, "name" | "sellerKey" | "sellerName">,
  photos: Readonly<Record<string, string>> = PRODUCT_PHOTOS,
): string | undefined {
  if (!isPlatformSeed(product)) return undefined;
  const seedId = SEED_ID_BY_NAME.get(product.name);
  const file = seedId === undefined ? undefined : photos[seedId];
  return file === undefined ? undefined : `/products/${file}`;
}
