import { randomBytes } from "node:crypto";
import { GENERIC_HANDLE_WORDS, PROTECTED_HANDLE_WORDS } from "@delulu/core";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HANDLE_AGREEMENT_CASES } from "../../core/src/screening/handle-cases";
import { companyQuote } from "../src/company";
import { createCoupon } from "../src/merchant";
import { updateProfile } from "../src/profile";
import { codeOf, type ProductFixture, user } from "./checkout-fixtures";
import { createTestDatabase, plant, stateOf, type TestDatabase, type TestUser, uuidv7 } from "./helpers";
import { creator, ensureCategories } from "./listing-fixtures";
import { completePassport, published } from "./selling-fixtures";

/** Letters that spell no protected or generic word in any fold. */
const safe = (n: number) => Array.from(randomBytes(n), (b) => "bcdfghjkqvwxz"[b % 13]).join("");
const handle = () => `lamps-${safe(10)}`;

/**
 * Seventh security review, minors 4, 5a and 7a (migration 0056): handle look-alikes for stores AND
 * users, public coupon codes, and handle squatting by rotating colluders.
 */
describe("seventh security review: handles and coupon codes", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let items: ProductFixture[];

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 20 });
    pool = db.pool;
    await ensureCategories(pool);
    items = await published(pool, 3);
  }, 120_000);
  afterAll(async () => {
    await db.drop();
  });

  // ------------------------------------------------------------------ minor 4
  it("minor 4: the database's protected and generic word lists are packages/core's", async () => {
    const { rows } = await pool.query<{ p: string[]; g: string[] }>(
      "SELECT core.handle_protected_words() AS p, core.handle_generic_words() AS g",
    );
    expect([...(rows[0]?.p ?? [])].sort()).toEqual([...PROTECTED_HANDLE_WORDS].sort());
    expect([...(rows[0]?.g ?? [])].sort()).toEqual([...GENERIC_HANDLE_WORDS].sort());
  });

  it.each(HANDLE_AGREEMENT_CASES.map((c) => [c.handle, c.accepted] as const))(
    "minor 4 (shared table with packages/core): user handle %s accepted=%s",
    async (h, accepted) => {
      const u = await user(pool);
      expect(await codeOf(updateProfile(pool, { authSessionId: u.authSessionId, handle: h }))).toBe(
        accepted ? "ok" : "CONFLICT",
      );
    },
  );

  it("minor 4: a look-alike company handle is refused whoever writes it; a generic word inside a longer handle is not", async () => {
    const insert = async (h: string) =>
      stateOf(
        pool,
        "INSERT INTO core.company (id, owner_user_id, name, handle) VALUES ($1, $2, 'Look Alike', $3)",
        [uuidv7(), (await user(pool)).userId, h],
      );
    for (const h of ["delulurnart", "adrnin", "admin1", "deluluofficial", "dellulumart", "shop1"]) {
      expect(await insert(h), h).toBe("23514");
    }
    for (const h of ["cake-shop", "acme-store", "root-beer", "pay-day", "api-studio"]) {
      expect(await insert(h), h).toBe("no error");
    }
  });

  it("minor 4: the reviewer's wrongly refused handles can be quoted; the accepted look-alikes cannot", async () => {
    for (const h of ["cake-shop", "acme-store", "root-beer", "pay-day", "api-studio"]) {
      const u = await user(pool);
      await completePassport(pool, u, items);
      expect(
        await codeOf(
          companyQuote(pool, {
            authSessionId: u.authSessionId,
            handle: h,
            displayName: "Moon Lamps",
            description: "",
          }),
        ),
        h,
      ).toBe("ok");
    }
    const u = await user(pool);
    await completePassport(pool, u, items);
    for (const h of [
      "delulurnart",
      "adrnin",
      "delulumart2",
      "admin1",
      "deluluofficial",
      "officialdelulu",
      "de1ulumartofficial",
      "dellulumart",
    ]) {
      expect(
        await codeOf(
          companyQuote(pool, {
            authSessionId: u.authSessionId,
            handle: h,
            displayName: "Moon Lamps",
            description: "",
          }),
        ),
        h,
      ).toBe("HANDLE_TAKEN");
    }
  });

  // ------------------------------------------------------------------ minor 5a
  it("minor 5a: a public coupon code with a protected word in any spelling is refused in the database; its charset stays strict", async () => {
    const c = await creator(pool, items);
    const make = (code: string) =>
      codeOf(
        createCoupon(pool, {
          authSessionId: c.u.authSessionId,
          coupon: { kind: "PERCENT", value: 5n, isPublic: true, publicCode: code },
        }),
      );
    for (const code of ["DELULU10", "0FFICIAL", "ADRNIN50", "STAFF20", "SUPP0RT"]) {
      expect(await make(code), code).toBe("VALIDATION_FAILED");
    }
    for (const code of ["MOON-10", "MOON 10", "<b>X</b>", "AB"])
      expect(await make(code), code).toBe("VALIDATION_FAILED");
    expect(await make("MOON10")).toBe("ok");
    expect(await make("SHOP20")).toBe("ok"); // generic words are fine in a code
  });

  // ------------------------------------------------------------------ minor 7a
  const quote = (u: TestUser, h: string) =>
    companyQuote(pool, {
      authSessionId: u.authSessionId,
      handle: h,
      displayName: "Moon Lamps",
      description: "",
    });
  const quoter = async () => {
    const u = await user(pool);
    await completePassport(pool, u, items);
    return u;
  };
  /** Ends `u`'s reservations of `h` `minutes` ago, unpaid (as time passing would). */
  const lapse = (h: string, u: TestUser, minutes: number) =>
    plant(pool, async (x) => {
      await x.query(
        `UPDATE core.handle_reservation SET expires_at = now() - make_interval(mins => $3),
                released_at = CASE WHEN released_at IS NULL THEN NULL ELSE now() - make_interval(mins => $3) END
          WHERE handle = $1 AND user_id = $2`,
        [h, u.userId, minutes],
      );
      await x.query(
        `UPDATE core.checkout_session SET expires_at = now() - make_interval(mins => $3)
          WHERE id IN (SELECT session_id FROM core.handle_reservation WHERE handle = $1 AND user_id = $2)`,
        [h, u.userId, minutes],
      );
    });

  /** Moves every hold of `h` `minutes` further into the past. */
  const earlier = (h: string, minutes: number) =>
    plant(pool, async (x) => {
      await x.query(
        `UPDATE core.handle_reservation SET expires_at = expires_at - make_interval(mins => $2),
                released_at = released_at - make_interval(mins => $2) WHERE handle = $1`,
        [h, minutes],
      );
      await x.query(
        `UPDATE core.checkout_session SET expires_at = expires_at - make_interval(mins => $2)
          WHERE id IN (SELECT session_id FROM core.handle_reservation WHERE handle = $1)`,
        [h, minutes],
      );
    });

  it("minor 7a: after a handle's second consecutive unpaid lapse within 24 hours nobody can reserve it for 30 minutes", async () => {
    const h = handle();
    const [a, b, c] = [await quoter(), await quoter(), await quoter()];
    expect(await codeOf(quote(a, h))).toBe("ok");
    await lapse(h, a, 2);
    expect(await codeOf(quote(b, h))).toBe("ok"); // one lapse: anyone else may take it
    await lapse(h, b, 1);
    expect(await codeOf(quote(c, h))).toBe("HANDLE_RESERVED");
    await earlier(h, 28); // the second lapse was 29 minutes ago
    expect(await codeOf(quote(c, h))).toBe("HANDLE_RESERVED");
    await earlier(h, 2); // 31 minutes ago
    expect(await codeOf(quote(c, h))).toBe("ok");
  });

  it("minor 7a: lapses more than 24 hours apart, or one person re-quoting, do not hold a handle back from others", async () => {
    const h = handle();
    const [a, b, c] = [await quoter(), await quoter(), await quoter()];
    await quote(a, h);
    await lapse(h, a, 25 * 60);
    await quote(b, h);
    await lapse(h, b, 1);
    expect(await codeOf(quote(c, h))).toBe("ok");
    // one person quoting the same handle again within its hold is one hold, not several lapses
    const h2 = handle();
    const d = await quoter();
    await quote(d, h2);
    await quote(d, h2);
    await quote(d, h2);
    await lapse(h2, d, 1);
    expect(await codeOf(quote(c, h2))).toBe("ok");
  });
});
