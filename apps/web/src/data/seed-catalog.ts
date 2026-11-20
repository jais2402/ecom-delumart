export type CategorySlug =
  | "impossible-tech"
  | "absurd-luxury"
  | "everyday-magic"
  | "imaginary-experiences"
  | "food-fantasies"
  | "cosmic-collectibles";

export interface Category {
  slug: CategorySlug;
  name: string;
  blurb: string;
}

export interface SeedProduct {
  id: string; // kebab-case, unique, e.g. "monsoon-in-a-jar"
  name: string; // 3–80 characters
  hook: string; // one line, up to 140 characters
  description: string; // 20–400 characters
  altText: string; // describes an imagined studio photo of the object, up to 200 characters
  category: CategorySlug;
  priceRupees: number; // whole rupees, between 100 and 1_000_000_000 (₹100 crore)
  templateHue: number; // integer 0–359, used to tint a placeholder illustration
  zapEligible: boolean;
}

export const CATEGORIES: readonly Category[] = [
  {
    slug: "impossible-tech",
    name: "Impossible Tech",
    blurb: "Gadgets that bend the laws of physics, politely and with a warranty card.",
  },
  {
    slug: "absurd-luxury",
    name: "Absurd Luxury",
    blurb: "Extravagant things nobody needs and everybody would like to own.",
  },
  {
    slug: "everyday-magic",
    name: "Everyday Magic",
    blurb: "Ordinary household problems, solved by things that should not exist.",
  },
  {
    slug: "imaginary-experiences",
    name: "Imaginary Experiences",
    blurb: "Trips, shows and moments that happen only in your head, mostly on trains.",
  },
  {
    slug: "food-fantasies",
    name: "Food Fantasies",
    blurb: "Snacks and feasts from a kitchen that runs entirely on imagination.",
  },
  {
    slug: "cosmic-collectibles",
    name: "Cosmic Collectibles",
    blurb: "Pieces of the sky, the moon and a few stars, lovingly catalogued.",
  },
];

export const SEED_PRODUCTS: readonly SeedProduct[] = [
  // ───────────── Impossible Tech ─────────────
  {
    id: "teleporting-tiffin-box",
    name: "Teleporting Tiffin Box",
    hook: "Your lunch arrives at your desk the moment you start feeling hungry.",
    description:
      "A steel lunch box with a tiny built-in door to elsewhere. Pack your dabba once in the morning and it turns up warm at the office, no matter which floor you sit on.",
    altText:
      "Studio photo of a steel tiffin box on a wooden desk, its tiny brass door slightly ajar with a soft glow spilling out.",
    category: "impossible-tech",
    priceRupees: 2999,
    templateHue: 12,
    zapEligible: true,
  },
  {
    id: "internet-that-only-works-on-tuesdays",
    name: "Internet That Only Works on Tuesdays",
    hook: "Lightning-fast connectivity, one day a week, guarded by a very stubborn router.",
    description:
      "On Tuesdays the signal is fast, cheerful and unlimited. The rest of the week it sends polite apology letters in place of emails. Not recommended for Mondays.",
    altText:
      "Studio photo of a sleek router with a small wall calendar pinned beside it, Tuesday circled in red marker.",
    category: "impossible-tech",
    priceRupees: 7450,
    templateHue: 205,
    zapEligible: true,
  },
  {
    id: "gravity-optional-ceiling-fan",
    name: "Gravity-Optional Ceiling Fan",
    hook: "Spins perfectly well on the ceiling, the floor, or in mid-air during a power cut.",
    description:
      "This ceiling fan has no particular opinion about up or down. Install it anywhere in the room and it will cool you with the same friendly whirr. The manual is mostly drawings of birds.",
    altText:
      "Studio photo of a white ceiling fan floating just above a rug, blades mid-spin and dust motes drifting around it.",
    category: "impossible-tech",
    priceRupees: 38500,
    templateHue: 48,
    zapEligible: true,
  },
  {
    id: "self-watering-cactus-with-opinions",
    name: "Self-Watering Cactus With Opinions",
    hook: "It waters itself and then offers a considered review of your life choices.",
    description:
      "A desk cactus that keeps its own soil moist and shares its thoughts in gentle, prickly sentences. Its feedback on your presentation is honest, sharp and occasionally spiky.",
    altText:
      "Studio photo of a terracotta pot holding a small green cactus wearing a tiny pair of round spectacles.",
    category: "impossible-tech",
    priceRupees: 480000,
    templateHue: 118,
    zapEligible: false,
  },
  {
    id: "hover-rickshaw-season-pass",
    name: "Hover Rickshaw Season Pass",
    hook: "Unlimited rides on a three-wheeler that floats politely above the potholes.",
    description:
      "A season pass for a rickshaw that skips the potholes by hovering over them. Includes a horn that plays a short tune and a driver who knows every shortcut through the sky.",
    altText:
      "Studio photo of a yellow hover rickshaw levitating over a painted street, its canopy catching warm afternoon light.",
    category: "impossible-tech",
    priceRupees: 2400000,
    templateHue: 52,
    zapEligible: false,
  },
  {
    id: "weather-forecast-that-argues-back",
    name: "Weather Forecast That Argues Back",
    hook: "Predicts the rain, then debates you about whether you should carry an umbrella.",
    description:
      "A pocket forecaster that reads the sky with great confidence and listens to your objections. It has been right about the rain roughly as often as you have been right about yours.",
    altText:
      "Studio photo of a brass weather station with a tiny speech bubble of clouds above a dial that reads Probably.",
    category: "impossible-tech",
    priceRupees: 9100000,
    templateHue: 200,
    zapEligible: false,
  },
  {
    id: "time-zone-shifting-wall-clock",
    name: "Time-Zone Shifting Wall Clock",
    hook: "One wall clock, every time zone at once, and it always remembers when lunch is.",
    description:
      "A large round clock with twenty-four faces that slide into place as you walk past. Handy for calling relatives abroad, mildly disorienting for everyone else in the house.",
    altText:
      "Studio photo of a large round wall clock with overlapping sliding faces, ticking in a bright sunlit hallway.",
    category: "impossible-tech",
    priceRupees: 18000000,
    templateHue: 280,
    zapEligible: false,
  },
  {
    id: "robot-butler-that-folds-fitted-sheets",
    name: "Robot Butler That Only Folds Fitted Sheets",
    hook: "Single-minded, precise and entirely uninterested in anything except the corners.",
    description:
      "A metal butler with four patient arms, built for one task: folding fitted sheets. It has achieved perfect corners on every attempt and refuses to discuss anything else.",
    altText:
      "Studio photo of a silver robot with four slim arms neatly folding a lavender fitted sheet on a bed.",
    category: "impossible-tech",
    priceRupees: 74000000,
    templateHue: 160,
    zapEligible: false,
  },
  {
    id: "pocket-solar-system-starter-kit",
    name: "Pocket Solar System Starter Kit",
    hook: "Eight planets, one sun, and a card asking you to keep it near a window.",
    description:
      "A compact solar system with a glowing sun, orbiting planets and a moon that needs gentle winding every Sunday. Comes in a box that looks suspiciously like a lunch tin.",
    altText:
      "Studio photo of a glass dome on a shelf holding a miniature glowing sun and eight tiny orbiting planets.",
    category: "impossible-tech",
    priceRupees: 310000000,
    templateHue: 30,
    zapEligible: false,
  },
  {
    id: "machine-that-invents-next-years-weather",
    name: "Machine That Invents Next Year's Weather",
    hook: "Ships with a dial for drizzle, a lever for sunshine and a button marked Surprise.",
    description:
      "A large cabinet of gears, copper pipes and humming valves that prepares next year's weather in advance. Results may vary and are delivered with a gentle drumroll.",
    altText:
      "Studio photo of a towering copper machine with gauges, dials and a glowing sky-blue window, lit from the side.",
    category: "impossible-tech",
    priceRupees: 860000000,
    templateHue: 218,
    zapEligible: false,
  },

  // ───────────── Absurd Luxury ─────────────
  {
    id: "gold-plated-chai-strainer",
    name: "Gold-Plated Chai Strainer",
    hook: "Strains your tea with the dignity it deserves and the shine it never asked for.",
    description:
      "A small strainer dipped in gleaming gold leaf for your morning cutting chai. Polish it once a week and it will outshine every other spoon in the kitchen.",
    altText:
      "Studio photo of a gleaming gold strainer resting across a steel tumbler of milky chai on a marble tray.",
    category: "absurd-luxury",
    priceRupees: 4200,
    templateHue: 42,
    zapEligible: true,
  },
  {
    id: "velvet-rope-for-a-pigeon",
    name: "Velvet Rope for a Pigeon",
    hook: "Exclusive queueing for the most important bird on the balcony.",
    description:
      "A tiny red velvet rope on brass posts, installed along the terrace railing so the pigeon can wait in style. The pigeon has not yet decided whether this is a compliment.",
    altText:
      "Studio photo of a tiny red velvet rope on brass posts beside a plump grey pigeon on a balcony ledge.",
    category: "absurd-luxury",
    priceRupees: 8900,
    templateHue: 355,
    zapEligible: true,
  },
  {
    id: "private-island-shaped-like-a-samosa",
    name: "Private Island Shaped Like a Samosa",
    hook: "Triangular, crispy at the edges, and surrounded by a very calm sea of chutney.",
    description:
      "A small private island with golden crusty shores and a green chutney lagoon. Comes with a boat made of pastry and a view that is best enjoyed with a cup of tea.",
    altText:
      "Studio photo of a golden triangular island on a turquoise tray, with a green chutney lagoon and a tiny pastry boat.",
    category: "absurd-luxury",
    priceRupees: 67000,
    templateHue: 36,
    zapEligible: true,
  },
  {
    id: "silk-bathrobe-woven-from-morning-fog",
    name: "Silk Bathrobe Woven From Morning Fog",
    hook: "Feather-light, perfectly drapey, and available only before the sun gets up.",
    description:
      "A bathrobe spun from the mist that settles over the hills at dawn. It wraps you in a soft grey cloud and quietly disappears as soon as breakfast begins.",
    altText:
      "Studio photo of a pale grey silk bathrobe draped over a chair, with soft wisps of mist curling around its sleeves.",
    category: "absurd-luxury",
    priceRupees: 415000,
    templateHue: 210,
    zapEligible: false,
  },
  {
    id: "penthouse-floating-above-a-raindrop",
    name: "Penthouse Floating Above a Raindrop",
    hook: "Four bedrooms, a rooftop garden and a view of the whole town upside down.",
    description:
      "A luxurious penthouse perched on top of one enormous raindrop. Cosy inside, sparkling outside, and the lift only goes up when it rains.",
    altText:
      "Studio photo of a tiny luxury penthouse with lit windows balanced on a glossy spherical raindrop, sunlight refracting through it.",
    category: "absurd-luxury",
    priceRupees: 3600000,
    templateHue: 196,
    zapEligible: false,
  },
  {
    id: "limousine-pulled-by-eleven-swans",
    name: "Limousine Pulled by Eleven Swans",
    hook: "Arrives gracefully at every occasion, including the ones you forgot to attend.",
    description:
      "A long, polished carriage drawn by eleven elegant swans in perfect formation. The swans hum while they work and accept only breadcrumbs of the finest quality.",
    altText:
      "Studio photo of a long black carriage pulled by eleven white swans in a neat line across a pond at sunset.",
    category: "absurd-luxury",
    priceRupees: 8750000,
    templateHue: 190,
    zapEligible: false,
  },
  {
    id: "heated-marble-throne-for-cats",
    name: "Heated Marble Throne for Cats",
    hook: "The warmest seat in the house, reserved for the cat who was there first.",
    description:
      "A cream marble throne with a gently warming seat and a cushion stitched with tiny fish. Guaranteed for two hundred years, or until the cat gets bored, whichever comes first.",
    altText:
      "Studio photo of an elegant cream marble throne with a plush cushion, with a sleepy ginger cat curled on top.",
    category: "absurd-luxury",
    priceRupees: 19500000,
    templateHue: 25,
    zapEligible: false,
  },
  {
    id: "diamond-kite-that-lifts-a-bungalow",
    name: "Diamond Kite That Lifts a Small Bungalow",
    hook: "Sparkles so brightly the sky takes notice and the neighbours look up.",
    description:
      "A diamond-shaped kite on a string strong enough to hold an entire bungalow. Ideal for flying over the rooftop wedding, the cricket final or the monsoon parade.",
    altText:
      "Studio photo of a huge faceted diamond-shaped kite with a small bungalow dangling beneath it, against a blue sky.",
    category: "absurd-luxury",
    priceRupees: 52000000,
    templateHue: 205,
    zapEligible: false,
  },
  {
    id: "royal-elephant-shaped-yacht",
    name: "Royal Elephant-Shaped Yacht",
    hook: "Trunk up at the front, flags on the tail, and the finest lagoon for Sunday mornings.",
    description:
      "A glossy yacht sculpted like a majestic elephant, with ivory-coloured decks and a trunk that doubles as a water slide. Requires one captain and a very patient ferry.",
    altText:
      "Studio photo of an ivory-and-gold yacht shaped like an elephant, floating calmly on a sparkling blue lake.",
    category: "absurd-luxury",
    priceRupees: 760000000,
    templateHue: 300,
    zapEligible: false,
  },
  {
    id: "palace-carved-from-one-giant-pearl",
    name: "Palace Carved From One Giant Pearl",
    hook: "Every room shimmers, every door is a clam, and the guest list is still being decided.",
    description:
      "A glowing palace sculpted from a single enormous pearl. Each room has its own soft lustre and a chandelier made from the leftover shavings.",
    altText:
      "Studio photo of a luminous pearl palace with arched windows and tiny spires, glowing softly on a velvet cushion.",
    category: "absurd-luxury",
    priceRupees: 980000000,
    templateHue: 340,
    zapEligible: false,
  },

  // ───────────── Everyday Magic ─────────────
  {
    id: "monsoon-in-a-jar",
    name: "Monsoon in a Jar",
    hook: "Open the lid for wet earth, a drumming roof and one free paper boat.",
    description:
      "A sealed glass jar holding one entire rainy afternoon. Twist it open on a dry day and the room fills with petrichor, distant thunder and the quiet hope of a long chai.",
    altText:
      "Studio photo of a glass jar filled with swirling grey mist and tiny raindrops, sitting on a wooden windowsill.",
    category: "everyday-magic",
    priceRupees: 1850,
    templateHue: 200,
    zapEligible: true,
  },
  {
    id: "portable-weekend",
    name: "Portable Weekend",
    hook: "Fold it into a pocket on Friday and unfold it on Monday for a little extra Saturday.",
    description:
      "A small folding weekend that fits neatly into a jacket pocket. Includes two unhurried mornings, one long nap and a sunset you can keep for later.",
    altText:
      "Studio photo of a small folded paper weekend with tiny calendar pages and a sunset tucked inside, resting on a leather wallet.",
    category: "everyday-magic",
    priceRupees: 6200,
    templateHue: 30,
    zapEligible: true,
  },
  {
    id: "second-hand-deja-vu",
    name: "Second-hand Déjà Vu",
    hook: "Like-new feelings of having been here before, lightly used by a stranger on a train.",
    description:
      "A pre-owned déjà vu that arrives with its own gentle sense of familiarity. The previous owner reports it was perfectly lovely at the railway station on a Thursday.",
    altText:
      "Studio photo of a vintage pocket watch with a faded label reading Like New, beside a worn train ticket.",
    category: "everyday-magic",
    priceRupees: 96000,
    templateHue: 265,
    zapEligible: true,
  },
  {
    id: "self-folding-laundry-basket",
    name: "Self-Folding Laundry Basket",
    hook: "Puts your shirts away in neat little squares while you finish a second cup of chai.",
    description:
      "A cane laundry basket that folds every item as it goes in and sorts them by colour. Works fastest when nobody is watching, and sulks politely if you try to help.",
    altText:
      "Studio photo of a woven cane laundry basket with neatly folded shirts stacked beside it on a tiled floor.",
    category: "everyday-magic",
    priceRupees: 430000,
    templateHue: 90,
    zapEligible: false,
  },
  {
    id: "left-sock-finder",
    name: "Left-Sock Finder",
    hook: "Gently hums whenever a single sock is lonely in the laundry.",
    description:
      "A small brass device that detects unpaired socks and nudges them back toward their partners. Rated excellent by people with very full drawers and very empty pairs.",
    altText:
      "Studio photo of a small brass gadget with a glowing needle pointing toward a lone striped sock on a wooden floor.",
    category: "everyday-magic",
    priceRupees: 2750000,
    templateHue: 15,
    zapEligible: false,
  },
  {
    id: "pocket-umbrella-that-stays-dry-forever",
    name: "Pocket Umbrella That Stays Dry Forever",
    hook: "Folds smaller than a biscuit, opens into a shelter, and never once has a wet handle.",
    description:
      "A tiny umbrella that opens to the size of a cosy tent and stays dry on the inside no matter how hard it rains. Has survived twelve monsoons and one very confused goat.",
    altText:
      "Studio photo of a bright yellow pocket umbrella open over a wooden bench, with a small dry puddle beneath it.",
    category: "everyday-magic",
    priceRupees: 8000000,
    templateHue: 52,
    zapEligible: false,
  },
  {
    id: "lamp-that-glows-when-nobody-is-looking",
    name: "Lamp That Glows Only When Nobody's Looking",
    hook: "Shy, warm and extremely reliable after bedtime.",
    description:
      "A ceramic table lamp that stays dim while anyone is in the room and beams gently the moment they leave. Ideal for quiet hallways, midnight snacks and secret reading.",
    altText:
      "Studio photo of a ceramic table lamp glowing softly in an empty, dim room with an open book beside it.",
    category: "everyday-magic",
    priceRupees: 22000000,
    templateHue: 240,
    zapEligible: false,
  },
  {
    id: "front-door-key-that-never-gets-lost",
    name: "Front-Door Key That Never Gets Lost",
    hook: "Always in your hand, always where you left it, and always exactly what you need.",
    description:
      "A brass house key that returns to your pocket whenever you pat it twice. Works on every door you own, including the one at your grandmother's and the one you keep forgetting.",
    altText:
      "Studio photo of an antique brass key on a red lanyard, resting on a wooden hall table beside a small dish.",
    category: "everyday-magic",
    priceRupees: 61000000,
    templateHue: 22,
    zapEligible: false,
  },
  {
    id: "kitchen-clock-that-stops-for-chai",
    name: "Kitchen Clock That Stops for Chai",
    hook: "Pauses the minutes while the tea is brewing and resumes only when the cup is empty.",
    description:
      "A cheerful wall clock that understands the importance of chai time. Set it once and it will politely freeze until you have had your first sip.",
    altText:
      "Studio photo of a round kitchen wall clock with its hands paused at a quarter past six, beside a steaming cup of chai.",
    category: "everyday-magic",
    priceRupees: 350000000,
    templateHue: 14,
    zapEligible: false,
  },
  {
    id: "wardrobe-that-reorganises-itself-by-mood",
    name: "Wardrobe That Reorganises Itself by Mood",
    hook: "Blue for Mondays, bright yellow for festivals, and a cosy row of jumpers for rainy evenings.",
    description:
      "A carved teak wardrobe that rearranges your clothes according to how you are feeling. It takes a short mood questionnaire each time the doors open. Accuracy may depend on the day.",
    altText:
      "Studio photo of a carved teak wardrobe with its doors half open, colourful clothes sorted into bright and calm bands.",
    category: "everyday-magic",
    priceRupees: 905000000,
    templateHue: 310,
    zapEligible: false,
  },

  // ───────────── Imaginary Experiences ─────────────
  {
    id: "train-window-seat-with-a-view-of-yesterday",
    name: "Train Window Seat With a View of Yesterday",
    hook: "Reserved seat, unreserved memories, and scenery you already waved goodbye to.",
    description:
      "A window seat on a slow evening train that looks out over yesterday's fields, rivers and lit-up platforms. Tea is served at every station, including the ones already passed.",
    altText:
      "Studio photo of a worn train window seat with a view of golden fields rolling past at dusk, a cup of tea on the sill.",
    category: "imaginary-experiences",
    priceRupees: 4999,
    templateHue: 35,
    zapEligible: true,
  },
  {
    id: "cricket-match-you-watched-in-a-dream",
    name: "Cricket Match You Watched in a Dream",
    hook: "Every boundary exactly where you remember it, and the commentator sounds like your uncle.",
    description:
      "A full cricket match replayed from memory, with dramatic last-over finishes and a crowd that cheers at all the right moments. Snacks not included.",
    altText:
      "Studio photo of a small glowing cricket stadium model in a dim room, with tiny floodlights and a hand-painted scoreboard.",
    category: "imaginary-experiences",
    priceRupees: 9500,
    templateHue: 130,
    zapEligible: true,
  },
  {
    id: "festival-night-lasting-three-minutes-longer",
    name: "Festival Night Lasting Three Minutes Longer",
    hook: "The lights, the music, the last sweet and the bit everyone remembers.",
    description:
      "A festival evening with three extra minutes added on at the end. Fill them with one more song, one more laugh and one more sparkler before the gates close.",
    altText:
      "Studio photo of a lantern-lit street fair at dusk with strings of marigolds and a clock showing three extra minutes.",
    category: "imaginary-experiences",
    priceRupees: 128000,
    templateHue: 12,
    zapEligible: true,
  },
  {
    id: "hill-station-that-never-opens-on-time",
    name: "Hill Station That Never Opens on Time",
    hook: "Misty mornings guaranteed, with check-in sometime after you finish your breakfast.",
    description:
      "A cosy hill retreat of wooden cottages wrapped in cloud. The gate opens whenever the mist decides, so bring a good book and a warm shawl.",
    altText:
      "Studio photo of a small wooden cottage on a misty green hill, with a gate half open and a lantern glowing.",
    category: "imaginary-experiences",
    priceRupees: 515000,
    templateHue: 110,
    zapEligible: false,
  },
  {
    id: "holiday-to-a-country-not-yet-invented",
    name: "Holiday to a Country That Hasn't Been Invented",
    hook: "Visa-free, currency-free and full of people who have never met a queue.",
    description:
      "A two-week trip to a brand-new country, designed by you on the back of a napkin. Your passport gets stamped with a sunset and your luggage arrives by hot-air balloon.",
    altText:
      "Studio photo of a hand-drawn map of an imaginary island country, with a tiny passport stamped with a sunset.",
    category: "imaginary-experiences",
    priceRupees: 3300000,
    templateHue: 175,
    zapEligible: false,
  },
  {
    id: "sunrise-ride-on-a-monsoon-cloud",
    name: "Sunrise Ride on a Monsoon Cloud",
    hook: "Soft, damp and surprisingly comfortable, with a front-row seat for the first light.",
    description:
      "A slow, fluffy cloud ride that drifts over the rooftops at dawn. Bring a flask of chai and a jacket; the cloud will drop you off gently in time for breakfast.",
    altText:
      "Studio photo of a plump grey monsoon cloud floating above rooftops at sunrise, with a small wooden bench on top.",
    category: "imaginary-experiences",
    priceRupees: 7200000,
    templateHue: 200,
    zapEligible: false,
  },
  {
    id: "front-row-seat-at-a-concert-played-by-ceiling-fans",
    name: "Front-Row Seat at a Concert Played by Ceiling Fans",
    hook: "Rhythmic whirring, breezy harmonies and a headline act that never stops spinning.",
    description:
      "Front-row tickets to a rock concert where every instrument is a ceiling fan. The band keeps time with their blades, and the crowd cools off on the second chorus.",
    altText:
      "Studio photo of a stage with a row of spinning ceiling fans lit in colourful stage lights, a crowd of silhouettes below.",
    category: "imaginary-experiences",
    priceRupees: 26000000,
    templateHue: 240,
    zapEligible: false,
  },
  {
    id: "magic-carpet-ride-through-one-ordinary-morning",
    name: "Magic Carpet Ride Through One Ordinary Morning",
    hook: "Same bus stop, same newspaper seller, but everything looks like it is being shown for the first time.",
    description:
      "A slow magic carpet ride that drifts over one ordinary Tuesday morning and lets you notice every small detail. Includes a breakfast served mid-air and a free view of the sea.",
    altText:
      "Studio photo of a patterned rug floating above a quiet street at dawn, with a teacup and a newspaper on board.",
    category: "imaginary-experiences",
    priceRupees: 68000000,
    templateHue: 330,
    zapEligible: false,
  },
  {
    id: "lifetime-pass-to-every-train-that-never-left",
    name: "Lifetime Pass to Every Train That Never Left",
    hook: "Hop on any platform, at any hour, bound for a station that was only ever a dream.",
    description:
      "A sturdy pass that lets you board every train that was planned but never actually left the station. Seats are always available and the conductor always punches your ticket with a smile.",
    altText:
      "Studio photo of a leather pass holder with a stamped ticket, placed on an empty railway platform at dawn.",
    category: "imaginary-experiences",
    priceRupees: 240000000,
    templateHue: 215,
    zapEligible: false,
  },
  {
    id: "seven-season-holiday-in-one-lunch-break",
    name: "Seven-Season Holiday in One Lunch Break",
    hook: "Spring, summer, monsoon, autumn, winter, dew and a second spring, all before your rice gets cold.",
    description:
      "A compressed holiday that packs seven seasons into a single lunch hour. Snow, blossoms, sunshine and a little rain, all served neatly on one steel thali.",
    altText:
      "Studio photo of a steel thali holding seven tiny dioramas of changing seasons, each under a little glass dome.",
    category: "imaginary-experiences",
    priceRupees: 790000000,
    templateHue: 100,
    zapEligible: false,
  },

  // ───────────── Food Fantasies ─────────────
  {
    id: "chai-that-tastes-like-your-childhood-monsoon",
    name: "Chai That Tastes Like Your Childhood Monsoon",
    hook: "Ginger, cardamom and a little rain on the verandah, poured into one small cup.",
    description:
      "A cup of cutting chai brewed to recall the rainy afternoons of your early years. Sip slowly and the memory of the paper boats comes along for free.",
    altText:
      "Studio photo of a small glass of frothy chai beside a window streaked with raindrops and a folded paper boat.",
    category: "food-fantasies",
    priceRupees: 3800,
    templateHue: 25,
    zapEligible: true,
  },
  {
    id: "samosa-that-has-never-been-cold",
    name: "Samosa That Has Never Been Cold",
    hook: "Crispy, warm, and still exactly as hot as the moment you bought it.",
    description:
      "A golden samosa that refuses to cool down, however long it sits on the desk or however many meetings it survives. Chutney is served on the side in a tiny brass bowl.",
    altText:
      "Studio photo of a golden triangular samosa on a steel plate, steam rising, next to a small bowl of green chutney.",
    category: "food-fantasies",
    priceRupees: 1199,
    templateHue: 38,
    zapEligible: true,
  },
  {
    id: "mango-season-in-a-teaspoon",
    name: "Mango Season in a Teaspoon",
    hook: "Summer sweetness, one spoonful at a time, without a single sticky finger.",
    description:
      "A teaspoon of concentrated mango season, ripe and golden, with a faint whiff of wooden crates and afternoon heat. Use sparingly; the summer lasts a long time.",
    altText:
      "Studio photo of a silver teaspoon holding a golden mango swirl, backlit by warm afternoon sunlight.",
    category: "food-fantasies",
    priceRupees: 45000,
    templateHue: 45,
    zapEligible: true,
  },
  {
    id: "infinite-pani-puri-vending-machine",
    name: "Infinite Pani Puri Vending Machine",
    hook: "Press the button once and it keeps refilling for as long as your appetite lasts.",
    description:
      "A bright blue vending machine that dispenses crisp puris, tangy water and spiced potato in endless rounds. Please hold your plate steady and mind the chutney drip.",
    altText:
      "Studio photo of a bright blue vending machine dispensing a row of crisp golden puris into a steel plate.",
    category: "food-fantasies",
    priceRupees: 310000,
    templateHue: 185,
    zapEligible: false,
  },
  {
    id: "breakfast-that-cooks-itself-on-the-commute",
    name: "Breakfast That Cooks Itself on the Commute",
    hook: "Ready, warm and neatly packed by the time the train reaches your stop.",
    description:
      "A steel lunchbox of hot idlis, chutney and a crisp paratha that cooks itself as you travel. Designed for early trains and very long walks to the bus stop.",
    altText:
      "Studio photo of a steel breakfast box with idlis and chutney, a faint steam rising from its lid on a train seat.",
    category: "food-fantasies",
    priceRupees: 2100000,
    templateHue: 28,
    zapEligible: false,
  },
  {
    id: "ice-cream-cone-that-remembers-every-flavour",
    name: "Ice Cream Cone That Remembers Every Flavour",
    hook: "Hands you back the exact scoop you loved as a child, one cone at a time.",
    description:
      "A crisp sugar cone with a built-in memory of every flavour it has ever held. Ask it for a favourite and it will recall the summer you liked it best.",
    altText:
      "Studio photo of a crisp waffle ice cream cone with a swirl of pastel scoops, placed on a sunny park bench.",
    category: "food-fantasies",
    priceRupees: 6000000,
    templateHue: 330,
    zapEligible: false,
  },
  {
    id: "biryani-scented-hot-air-balloon",
    name: "Biryani-Scented Hot Air Balloon",
    hook: "Rises slowly over the rooftops, leaving a trail of saffron and happiness behind.",
    description:
      "A striped hot air balloon that drifts across the city carrying the warm, spicy smell of a Sunday biryani. Passengers are advised to keep their elbows out of the rice.",
    altText:
      "Studio photo of a striped hot air balloon floating over domed rooftops at sunset, faint saffron wisps trailing behind.",
    category: "food-fantasies",
    priceRupees: 14000000,
    templateHue: 20,
    zapEligible: false,
  },
  {
    id: "dosa-large-enough-to-cover-a-cricket-pitch",
    name: "Dosa Large Enough to Cover a Cricket Pitch",
    hook: "Crisp, golden and so big it needs a full team of waiters and one very patient umpire.",
    description:
      "A crisp golden dosa spread neatly across an entire cricket pitch. Served with coconut chutney and sambar in buckets, with a boundary of extra-crispy edges.",
    altText:
      "Studio photo of a vast crisp golden dosa spread across a green cricket pitch, with small stumps poking out from the edges.",
    category: "food-fantasies",
    priceRupees: 88000000,
    templateHue: 40,
    zapEligible: false,
  },
  {
    id: "golden-laddoo-mountain",
    name: "Golden Laddoo Mountain",
    hook: "A peak of sweet round treats, climbed one bite at a time, with a view of the sugar clouds.",
    description:
      "A small mountain made entirely of golden besan laddoos, with winding paths of jaggery and a summit crowned by cardamom snow. Sturdy trekking shoes recommended.",
    altText:
      "Studio photo of a golden mountain of besan laddoos sprinkled with pistachio, with a winding path of jaggery up its side.",
    category: "food-fantasies",
    priceRupees: 420000000,
    templateHue: 42,
    zapEligible: false,
  },
  {
    id: "restaurant-where-only-the-dessert-is-real",
    name: "Restaurant Where Only the Dessert Is Real",
    hook: "The starters and mains are pure imagination; the kulfi, however, is entirely genuine.",
    description:
      "An elegant restaurant serving imaginary starters and mains, with a dessert trolley as the only thing on the menu that exists. Every spoonful of kulfi is wonderfully real.",
    altText:
      "Studio photo of a candlelit table with empty plates and a single pistachio kulfi on a silver dish.",
    category: "food-fantasies",
    priceRupees: 975000000,
    templateHue: 355,
    zapEligible: false,
  },

  // ───────────── Cosmic Collectibles ─────────────
  {
    id: "bottle-of-starlight-from-last-tuesday",
    name: "Bottle of Starlight From Last Tuesday",
    hook: "Stars from a clear night nobody noticed, carefully bottled for a dull afternoon.",
    description:
      "A small glass bottle with a gentle shimmer of starlight, collected last Tuesday when the sky was clearer than usual. Uncork it in a quiet room for a tiny private sky.",
    altText:
      "Studio photo of a small glass bottle glowing with silver starlight, standing on a dark velvet cloth.",
    category: "cosmic-collectibles",
    priceRupees: 5555,
    templateHue: 240,
    zapEligible: true,
  },
  {
    id: "moon-crater-snow-globe",
    name: "Moon Crater Snow Globe",
    hook: "Shake it gently and watch silver moon dust settle over a very patient astronaut.",
    description:
      "A round glass globe holding a miniature cratered moon and a drift of silver dust. Shake it to start a gentle lunar snowfall that lasts until the kettle boils.",
    altText:
      "Studio photo of a glass snow globe containing a grey cratered moon landscape with silver dust drifting across it.",
    category: "cosmic-collectibles",
    priceRupees: 8800,
    templateHue: 225,
    zapEligible: true,
  },
  {
    id: "pocket-comet-with-friendly-tail",
    name: "Pocket Comet With Friendly Tail",
    hook: "A small, cheerful comet that wags its tail whenever you walk into the room.",
    description:
      "A palm-sized comet with a glowing tail that sways like a happy dog when you come home. Feed it a pinch of stardust once a month and it will never wander off.",
    altText:
      "Studio photo of a palm-sized glowing comet with a shimmering blue tail, resting on a wooden desk beside a notebook.",
    category: "cosmic-collectibles",
    priceRupees: 290000,
    templateHue: 210,
    zapEligible: true,
  },
  {
    id: "mini-galaxy-in-a-teacup",
    name: "Mini Galaxy in a Teacup",
    hook: "Swirling arms of stardust in a cup that never goes cold.",
    description:
      "A teacup holding a spiral galaxy with a few million tiny stars. Stir slowly with a silver spoon and the galaxy adjusts its spin to match your mood.",
    altText:
      "Studio photo of a white porcelain teacup holding a swirling spiral galaxy of violet and gold stars.",
    category: "cosmic-collectibles",
    priceRupees: 620000,
    templateHue: 265,
    zapEligible: false,
  },
  {
    id: "asteroid-named-after-your-cat",
    name: "Asteroid Named After Your Cat",
    hook: "Officially registered in your cat's name, on a small orbit that passes the kitchen window.",
    description:
      "A lumpy grey asteroid with a certificate naming it after your favourite cat. It circles the kitchen once a day and occasionally nudges a biscuit off the shelf.",
    altText:
      "Studio photo of a lumpy grey asteroid on a display stand, with a small brass plaque engraved with a cat's name.",
    category: "cosmic-collectibles",
    priceRupees: 2800000,
    templateHue: 5,
    zapEligible: false,
  },
  {
    id: "constellation-stamp-collection-mint-condition",
    name: "Constellation Stamp Collection, Mint Condition",
    hook: "Every star pattern in a tidy album, perforated, postmarked and ready for the post.",
    description:
      "A limited album of twelve star constellations printed as postage stamps, each one faintly glowing in the dark. Postmarked with the year the sky was first observed.",
    altText:
      "Studio photo of a leather stamp album open to pages of glowing constellation stamps, beside a brass magnifying glass.",
    category: "cosmic-collectibles",
    priceRupees: 7700000,
    templateHue: 235,
    zapEligible: false,
  },
  {
    id: "nebula-scarf-for-chilly-evenings",
    name: "Nebula Scarf for Chilly Evenings",
    hook: "Soft, swirling and warm enough to wrap around an entire galaxy of thoughts.",
    description:
      "A knitted scarf dyed in the colours of a distant nebula, with pink and teal clouds that drift when the wind picks up. Keeps the neck cosy and the stars company.",
    altText:
      "Studio photo of a long knitted scarf in pink and teal nebula colours draped over a wooden chair under a starry sky.",
    category: "cosmic-collectibles",
    priceRupees: 23000000,
    templateHue: 290,
    zapEligible: false,
  },
  {
    id: "solar-flare-lamp-with-dimmer-switch",
    name: "Solar Flare Lamp With Dimmer Switch",
    hook: "All the brightness of a star, with a dimmer for when the neighbours complain.",
    description:
      "A brass lamp containing a small, tightly contained solar flare, with a dial that runs from gentle glow to full blazing noon. Please keep it away from curtains and cats with ambitions.",
    altText:
      "Studio photo of a brass desk lamp with a glowing orange solar flare inside its glass dome, casting warm light on books.",
    category: "cosmic-collectibles",
    priceRupees: 57000000,
    templateHue: 18,
    zapEligible: false,
  },
  {
    id: "private-planet-with-two-moons-and-a-fridge",
    name: "Private Planet With Two Moons and a Fridge",
    hook: "Plenty of room, two lovely moons for evening walks, and a fridge with surprisingly good ice.",
    description:
      "A quiet little planet with two moons, a pale blue ocean and a working refrigerator at the edge of a crater. Sold with a map, a sunset and a very friendly comet.",
    altText:
      "Studio photo of a small blue planet with two pale moons on a dark display stand, a tiny fridge placed on its surface.",
    category: "cosmic-collectibles",
    priceRupees: 480000000,
    templateHue: 205,
    zapEligible: false,
  },
  {
    id: "shooting-star-sold-individually-at-auction",
    name: "Shooting Star Sold Individually at Auction",
    hook: "One streak of light, caught mid-fall, and offered to the highest-spirited bidder at sunset.",
    description:
      "A single shooting star, caught on a silver net and cooled into a glowing pebble for display. Comes with a wish card already written in invisible ink.",
    altText:
      "Studio photo of a glowing pebble of light with a bright streak trail, displayed on a silver cushion under a spotlight.",
    category: "cosmic-collectibles",
    priceRupees: 930000000,
    templateHue: 245,
    zapEligible: false,
  },
];
