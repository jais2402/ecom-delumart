import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { HANDLE_AGREEMENT_CASES } from "./handle-cases";
import {
  foldHandle,
  GENERIC_HANDLE_WORDS,
  isLookalikeHandle,
  normaliseForScreening,
  PROTECTED_HANDLE_WORDS,
  RESERVED_HANDLES,
  type ScreenCode,
  type ScreenVerdict,
  screenText,
  validateHandle,
  validateStoreName,
} from "./index";

type Row = [input: string, verdict: ScreenVerdict, code?: ScreenCode];

/** Screening verdicts for one field (D). Codes name the first rule that decided the verdict. */
const TABLE: Row[] = [
  // OK
  ["A lamp that is mostly moon and partly nap.", "OK"],
  ["Socks that remember where the other one went", "OK"],
  ["Cloud umbrella: rains only on Tuesdays", "OK"],
  ["Pocket-sized thunderstorm for warm days", "OK"],
  ["Mango-scented alarm clock that whispers", "OK"],
  ["A kettle that sings 3 songs in Hindi", "OK"],
  ["Dreamy pillow v2", "OK"],
  ["Cup in a cup in a cup", "OK"], // 'cup in' must not read as 'upi'
  ["Happy paws: a mat for cats", "OK"],
  ["Shampoo for clouds, 250 ml", "OK"],
  ["Repayment-free imagination", "OK"],
  // links and domains
  ["Visit https://example.com for more", "REJECT", "LINK"],
  ["see www.mystore.in", "REJECT", "LINK"],
  ["buy at moonlamp.shop today", "REJECT", "LINK"],
  ["moonlamp dot com", "REJECT", "LINK"],
  ["moonlamp (dot) in", "REJECT", "LINK"],
  ["ｍｏｏｎｌａｍｐ．ｃｏｍ", "REJECT", "LINK"], // fullwidth look-alikes
  // email addresses
  ["write to maker@example.com", "REJECT", "EMAIL"],
  ["maker (at) example (dot) com", "REJECT", "EMAIL"],
  ["maker [at] gmail", "REJECT", "EMAIL"],
  // phone-like digit runs
  ["call 9876543210", "REJECT", "PHONE"],
  ["ring +91 98765 43210 now", "REJECT", "PHONE"],
  ["98-76-54-32-10", "REJECT", "PHONE"],
  ["nine eight seven six five four three two one zero", "REJECT", "PHONE"],
  ["９８７６５４３２１０", "REJECT", "PHONE"], // fullwidth digits
  // payment solicitation
  ["pay via upi please", "REJECT", "PAYMENT"],
  ["U P I accepted", "REJECT", "PAYMENT"],
  ["u.p.i only", "REJECT", "PAYMENT"],
  ["send on paytm", "REJECT", "PAYMENT"],
  ["P@YTM me", "REJECT", "PAYMENT"],
  ["gpay works", "REJECT", "PAYMENT"],
  ["G-Pay works", "REJECT", "PAYMENT"],
  ["phonepe accepted", "REJECT", "PAYMENT"],
  ["bank transfer only", "REJECT", "PAYMENT"],
  ["pay me directly", "REJECT", "PAYMENT"],
  ["paaaay   meee", "REJECT", "PAYMENT"], // repeated characters
  ["ρaytm", "REJECT", "PAYMENT"], // Greek rho for p
  ["раytm", "REJECT", "PAYMENT"], // Cyrillic р and а
  // blocklist
  ["this is fucking great", "REJECT", "BLOCKED_TERM"],
  ["f u c k this", "REJECT", "BLOCKED_TERM"],
  ["fuuuuck", "REJECT", "BLOCKED_TERM"],
  ["f*ck", "REJECT", "BLOCKED_TERM"],
  ["ki11 yourself", "REJECT", "BLOCKED_TERM"],
  ["p0rn lamp", "REJECT", "BLOCKED_TERM"],
  // needs review
  ["The official moon lamp", "NEEDS_REVIEW", "OFFICIAL"],
  ["verified seller of naps", "NEEDS_REVIEW", "OFFICIAL"],
  ["Government approved socks", "NEEDS_REVIEW", "OFFICIAL"],
  ["call customer care", "NEEDS_REVIEW", "OFFICIAL"],
  ["Police siren pillow", "NEEDS_REVIEW", "OFFICIAL"],
  ["Bank of Dreams piggy", "NEEDS_REVIEW", "OFFICIAL"],
  ["0fficial lamp", "NEEDS_REVIEW", "OFFICIAL"],
  ["Like Apple but sillier", "NEEDS_REVIEW", "BRAND"],
  ["Flipkart-style mug", "NEEDS_REVIEW", "BRAND"],
  ["BEST LAMP EVER MADE", "NEEDS_REVIEW", "CAPS"],
  ["free money giveaway lamp", "NEEDS_REVIEW", "WATCH"],
  ["dm me on whatsapp", "NEEDS_REVIEW", "WATCH"],
];

describe("screenText (D)", () => {
  it("has a table of at least 40 inputs", () => {
    expect(TABLE.length).toBeGreaterThanOrEqual(40);
  });

  it.each(TABLE)("%s → %s %s", (input, verdict, code) => {
    const result = screenText({ concept: input });
    expect(result.verdict).toBe(verdict);
    if (code === undefined) expect(result.reasons).toEqual([]);
    else expect(result.reasons).toContainEqual({ field: "concept", code });
  });

  it("REJECT outranks NEEDS_REVIEW, and reasons name each field", () => {
    const r = screenText({ name: "Official lamp", description: "pay via upi", handle: "moon-lamp" });
    expect(r.verdict).toBe("REJECT");
    expect(r.reasons).toContainEqual({ field: "name", code: "OFFICIAL" });
    expect(r.reasons).toContainEqual({ field: "description", code: "PAYMENT" });
    expect(r.reasons.some((x) => x.field === "handle")).toBe(false);
  });

  it("an empty field is OK; reasons are unique per field and code", () => {
    expect(screenText({ a: "" })).toEqual({ verdict: "OK", reasons: [] });
    const r = screenText({ a: "upi upi paytm" });
    expect(r.reasons.filter((x) => x.code === "PAYMENT")).toHaveLength(1);
  });

  it("normalises case, look-alikes and repeats", () => {
    expect(normaliseForScreening("ＨＥＬＬＯ")).toBe("helo");
    expect(normaliseForScreening("Ρаytm")).toBe("paytm");
    expect(normaliseForScreening("fuuuck")).toBe("fuck");
    expect(normaliseForScreening("café")).toBe("cafe");
  });

  it("property: screening never throws and the verdict follows the reasons", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string({ maxLength: 8 }), fc.string({ maxLength: 300 })), (fields) => {
        const r = screenText(fields);
        const codes = new Set(r.reasons.map((x) => x.code));
        const rejects = ["LINK", "EMAIL", "PHONE", "PAYMENT", "BLOCKED_TERM"].some((c) =>
          codes.has(c as ScreenCode),
        );
        expect(r.verdict).toBe(rejects ? "REJECT" : codes.size > 0 ? "NEEDS_REVIEW" : "OK");
        for (const reason of r.reasons) expect(Object.keys(fields)).toContain(reason.field);
      }),
    );
  });
});

describe("validateHandle (D)", () => {
  it.each([
    ["moon-lamp", null],
    ["abc", null],
    ["a1-b2-c3", null],
    ["x".repeat(24), null],
    ["ab", "TOO_SHORT"],
    ["x".repeat(25), "TOO_LONG"],
    ["Moon", "BAD_CHARACTERS"],
    ["moon_lamp", "BAD_CHARACTERS"],
    ["moon lamp", "BAD_CHARACTERS"],
    ["möön", "BAD_CHARACTERS"],
    ["-moon", "HYPHEN_EDGE"],
    ["moon-", "HYPHEN_EDGE"],
    ["moon--lamp", "DOUBLE_HYPHEN"],
    ["admin", "RESERVED"],
    ["delulumart", "RESERVED"],
    ["checkout", "RESERVED"],
  ])("%s → %s", (handle, code) => {
    const r = validateHandle(handle);
    if (code === null) expect(r).toEqual({ ok: true, value: handle });
    else expect(r).toEqual({ ok: false, code });
  });

  it("the reserved list is the one in the rules", () => {
    expect([...RESERVED_HANDLES].sort()).toEqual(
      [
        "admin",
        "support",
        "delulumart",
        "delulu",
        "staff",
        "official",
        "help",
        "system",
        "root",
        "moderator",
        "bank",
        "pay",
        "originals",
        "store",
        "shop",
        "www",
        "api",
        "account",
        "cart",
        "checkout",
        "orders",
        "console",
        "partner",
      ].sort(),
    );
    for (const h of RESERVED_HANDLES) expect(validateHandle(h)).toEqual({ ok: false, code: "RESERVED" });
  });

  it("property: an accepted handle is 3–24 of [a-z0-9-] with no edge or double hyphen", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), (s) => {
        const r = validateHandle(s);
        if (r.ok) {
          expect(r.value).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
          expect(r.value.length).toBeGreaterThanOrEqual(3);
          expect(r.value.length).toBeLessThanOrEqual(24);
        }
      }),
    );
  });
});

describe("validateStoreName (D)", () => {
  it.each([
    ["Moon Lamps", { ok: true, value: "Moon Lamps" }],
    ["  Moon Lamps  ", { ok: true, value: "Moon Lamps" }],
    ["abc", { ok: true, value: "abc" }],
    ["x".repeat(40), { ok: true, value: "x".repeat(40) }],
    ["ab", { ok: false, code: "TOO_SHORT" }],
    ["   ab   ", { ok: false, code: "TOO_SHORT" }],
    ["x".repeat(41), { ok: false, code: "TOO_LONG" }],
    ["Moon\u0000Lamps", { ok: false, code: "CONTROL_CHARACTERS" }],
    ["Moon\nLamps", { ok: false, code: "CONTROL_CHARACTERS" }],
  ])("%j", (name, expected) => {
    expect(validateStoreName(name)).toEqual(expected);
  });
});

describe("look-alike store handles (sixth security review, minor 6)", () => {
  it.each(HANDLE_AGREEMENT_CASES.map((c) => [c.handle, c.accepted] as const))(
    "shared table: %s accepted=%s",
    (handle, accepted) => {
      const r = validateHandle(handle);
      expect(r.ok).toBe(accepted);
      if (!r.ok) expect(r.code).toBe("RESERVED");
    },
  );

  it("folds 0→o, 1/i/l→l, 3→e, 4→a, 5→s, 7→t, 8→b, drops hyphens, reads rn as m and collapses repeated letters", () => {
    expect(foldHandle("de1ulumart")).toBe(foldHandle("delulumart"));
    expect(foldHandle("deluiumart")).toBe(foldHandle("delulumart"));
    // seventh review (minor 4): rn→m and repeated letters (the run 'llll' is one 'l')
    expect(foldHandle("0-1-i-l-3-4-5-7-8")).toBe("oleastb");
    expect(foldHandle("delulurnart")).toBe(foldHandle("delulumart"));
    expect(foldHandle("dellulumart")).toBe(foldHandle("delulumart"));
    expect(foldHandle("adrnin")).toBe(foldHandle("admin"));
  });

  it("the protected and generic word lists cover the reserved list; protected words are the brand and authority words", () => {
    const all = new Set([...PROTECTED_HANDLE_WORDS, ...GENERIC_HANDLE_WORDS]);
    for (const h of RESERVED_HANDLES) expect(all.has(h), h).toBe(true);
    for (const w of [
      "delulu",
      "delulumart",
      "admin",
      "administrator",
      "official",
      "support",
      "staff",
      "moderator",
      "security",
      "verified",
      "system",
      "superadmin",
    ])
      expect(PROTECTED_HANDLE_WORDS, w).toContain(w);
    for (const w of ["shop", "store", "pay", "api", "root", "help", "www"])
      expect(GENERIC_HANDLE_WORDS, w).toContain(w);
  });

  const reverse: Record<string, string[]> = {
    o: ["0", "oo"],
    l: ["1", "i", "ll"],
    i: ["1", "l"],
    e: ["3", "ee"],
    a: ["4"],
    s: ["5", "ss"],
    t: ["7"],
    b: ["8"],
    m: ["rn"],
  };
  const spell = (words: readonly string[]) =>
    fc
      .constantFrom(...words)
      .chain((h) =>
        fc
          .tuple(...[...h].map((ch) => fc.constantFrom(ch, ...(reverse[ch] ?? []))))
          .map((chars) => chars.join("")),
      );

  it("property: a protected word in any confusable spelling is refused anywhere in a handle, digits and hyphens included", () => {
    const filler = fc.stringMatching(/^[a-z0-9]{0,5}$/);
    fc.assert(
      fc.property(
        spell(PROTECTED_HANDLE_WORDS),
        filler,
        filler,
        fc.boolean(),
        fc.boolean(),
        (bad, pre, post, h1, h2) => {
          const handle = `${pre}${pre && h1 ? "-" : ""}${bad}${post && h2 ? "-" : ""}${post}`;
          expect(isLookalikeHandle(handle), handle).toBe(true);
          if (handle.length <= 24)
            expect(validateHandle(handle), handle).toEqual({ ok: false, code: "RESERVED" });
        },
      ),
    );
  });

  it("property: a generic word in any confusable spelling is refused as the whole handle, with or without leading and trailing digits", () => {
    const digits = fc.stringMatching(/^[0-9]{0,3}$/);
    fc.assert(
      fc.property(spell(GENERIC_HANDLE_WORDS), digits, digits, (bad, pre, post) => {
        const handle = `${pre}${bad}${post}`;
        expect(isLookalikeHandle(handle), handle).toBe(true);
      }),
    );
  });

  it("property: a generic word next to an ordinary word is accepted", () => {
    // letters that spell no protected or generic word, in any fold
    const word = fc.stringMatching(/^[bcdfghjkqvwxz]{3,8}$/);
    fc.assert(
      fc.property(fc.constantFrom(...GENERIC_HANDLE_WORDS), word, fc.boolean(), (generic, other, before) => {
        const handle = before ? `${other}-${generic}` : `${generic}-${other}`;
        if (handle.length <= 24) expect(validateHandle(handle), handle).toEqual({ ok: true, value: handle });
      }),
    );
  });
});
