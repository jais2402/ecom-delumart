import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { screenListing } from "../listing/index";
import { BYPASS_ATTACKS, NOT_A_CARD_NUMBER } from "./attack-cases";
import { screenText } from "./index";

const codes = (t: string) => screenText({ t }).reasons.map((r) => r.code);

describe("screening bypasses (review round 1, M1)", () => {
  it("M1: every reported attack string is refused with its code", () => {
    for (const [text, code] of BYPASS_ATTACKS) {
      const r = screenText({ text });
      expect(r.verdict, text).toBe("REJECT");
      expect(
        r.reasons.map((x) => x.code),
        text,
      ).toContain(code);
    }
  });

  it("M1: the listing screening refuses them too", () => {
    const listing = {
      name: "Moon Lamp",
      hook: "Mostly moon, partly nap.",
      description: "A lamp that is mostly moon and partly nap, for desks that dream.",
      altText: "A round lamp glowing like a full moon",
    };
    for (const [text] of BYPASS_ATTACKS) {
      for (const field of ["name", "hook", "description", "altText"] as const) {
        expect(
          screenListing({ ...listing, [field]: `${listing[field]} ${text}` }).verdict,
          `${field}: ${text}`,
        ).toBe("REJECT");
      }
    }
  });

  it("M1: a card-like number that is not a real card is refused", () => {
    expect(codes(`card ${NOT_A_CARD_NUMBER}`)).toContain("PHONE");
  });

  it("M1: format and separator characters are refused (zero-width, bidi controls, BOM, soft hyphen, line and paragraph separators)", () => {
    for (const ch of ["​", "‌", "‍", "‎", "‮", "⁦", "﻿", "­", " ", " ", "⁠"]) {
      expect(codes(`nice${ch}lamp`), JSON.stringify(ch)).toContain("INVISIBLE");
    }
  });

  it("M1: a joiner after an Indic letter or sign is ordinary writing, not hiding", () => {
    // Devanagari half-form with ZWJ, Malayalam chillu with ZWJ, a ZWNJ in Kannada
    expect(screenText({ t: "क्‍ष बहुत अच्छा" }).verdict).toBe("OK");
    expect(screenText({ t: "അവന്‍ നല്ലത്" }).verdict).toBe("OK");
    expect(screenText({ t: "ಕ್‌ಷ" }).verdict).toBe("OK");
    // but never after a Latin letter or at the start
    expect(codes("ht‍tps")).toContain("INVISIBLE");
    expect(codes("‍क")).toContain("INVISIBLE");
  });

  it("M1: digits of every Indian script, Arabic-Indic and fullwidth digits count for phone and card numbers", () => {
    const tenDigits = [
      "०१२३४५६७८९",
      "০১২৩৪৫৬৭৮৯",
      "੦੧੨੩੪੫੬੭੮੯",
      "૦૧૨૩૪૫૬૭૮૯",
      "୦୧୨୩୪୫୬୭୮୯",
      "௦௧௨௩௪௫௬௭௮௯",
      "౦౧౨౩౪౫౬౭౮౯",
      "೦೧೨೩೪೫೬೭೮೯",
      "൦൧൨൩൪൫൬൭൮൯",
      "٠١٢٣٤٥٦٧٨٩",
      "۰۱۲۳۴۵۶۷۸۹",
      "０１２３４５６７８９",
    ];
    for (const d of tenDigits) expect(codes(`ring ${d}`), d).toContain("PHONE");
    expect(codes("98765 ४३२१०")).toContain("PHONE");
    expect(screenText({ t: "कमरा ४५ में" }).verdict).toBe("OK");
  });

  it("M1: a dotted domain-like word is a link whatever its ending; prose with a full stop and a space is not", () => {
    for (const t of [
      "evil.ru",
      "visit shop.example now",
      "go to my-shop.xyz",
      "HTTP://EVIL.RU",
      "moon.lamp",
      "x.co",
    ])
      expect(codes(t), t).toContain("LINK");
    for (const t of [
      "fine. great",
      "It works. Really well.",
      "Mr. Rao liked it",
      "e.g. a lamp",
      "i.e. the moon",
      "4.5 stars, v2.0",
      "Wait... what?",
      "U.S.A. made",
      "c/o Mrs. Meena Sharma, H.No. 1-2-345/A",
      "S.No. 12, P.O. Box 4",
    ])
      expect(codes(t), t).not.toContain("LINK");
  });

  it("M1: spelled-out addresses ('evil dot ru slash x', 'shop dot com') are links", () => {
    for (const t of ["evil dot ru slash x", "moonshop dot com", "find me at lamps dot in"])
      expect(codes(t), t).toContain("LINK");
  });

  it("M1 (property): sentences of everyday words never read as links unless they spell an address out", () => {
    const words = [
      "the",
      "lamp",
      "dot",
      "slash",
      "is",
      "a",
      "moon",
      "com",
      "in",
      "great",
      "fine",
      "really",
      "glows",
      "connect",
      "dots",
      "to",
      "me",
      "on",
      "and",
      "it",
      "ru",
      "so",
      "do",
      "up",
    ];
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...words), { minLength: 1, maxLength: 12 }),
        fc.boolean(),
        (ws, stop) => {
          const text = ws.join(" ") + (stop ? ". Fine." : "");
          const spelled =
            /[a-z] dot (?:com|in|net|org|io|co|xyz|app|me|ly|gg|shop|store|info|biz|online|site|link)\b/.test(
              text,
            ) || /\bdot [a-z]{2,3} slash\b/.test(text);
          expect(codes(text).includes("LINK"), text).toBe(spelled);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("M1 (property): a full stop and a space between two words is never a link; without the space it is", () => {
    const word = fc.stringMatching(/^[a-z]{2,10}$/).filter((w) => w !== "www");
    fc.assert(
      fc.property(word, word, (a, b) => {
        expect(codes(`${a}. ${b}`), `${a}. ${b}`).not.toContain("LINK");
        expect(codes(`${a}.${b}`), `${a}.${b}`).toContain("LINK");
      }),
    );
  });
});
