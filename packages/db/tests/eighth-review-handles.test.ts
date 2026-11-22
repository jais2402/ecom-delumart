import {
  ADJACENT_HANDLE_WORDS,
  GENERIC_HANDLE_WORDS,
  hasProtectedHandleWord,
  isLookalikeHandle,
  LONG_PROTECTED_HANDLE_WORDS,
  SHORT_PROTECTED_HANDLE_WORDS,
  shortHandleForms,
} from "@delulu/core";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HANDLE_AGREEMENT_CASES } from "../../core/src/screening/handle-cases";
import { createTestDatabase, type TestDatabase } from "./helpers";

/** How many generated handles the agreement fuzz compares (CI: 1000; HANDLE_FUZZ_COUNT=30000 for the full run). */
const FUZZ = Number(process.env.HANDLE_FUZZ_COUNT ?? 1000);

/** A small seeded generator (mulberry32), so a failure can be replayed with its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SPELL: Record<string, string[]> = {
  o: ["0", "oo"],
  l: ["1", "i", "ll"],
  i: ["1", "l"],
  e: ["3", "c"],
  a: ["4"],
  s: ["5", "ss"],
  t: ["7"],
  b: ["8"],
  m: ["rn", "nn"],
  d: ["cl"],
  w: ["vv"],
};
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const NAMES = [
  "mustafa",
  "gustaf",
  "badminton",
  "ecosystem",
  "eastafrica",
  "staffy",
  "aarav",
  "oliver",
  "moon",
  "lamp",
];

/** Handles near the rules' edges: words in confusable spellings, mutated, joined, with digits and hyphens. */
function generate(n: number, seed: number): string[] {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const words = [
    ...LONG_PROTECTED_HANDLE_WORDS,
    ...SHORT_PROTECTED_HANDLE_WORDS,
    ...GENERIC_HANDLE_WORDS,
    ...ADJACENT_HANDLE_WORDS,
    ...NAMES,
  ];
  const spell = (w: string) => [...w].map((c) => (r() < 0.25 ? pick(SPELL[c] ?? [c]) : c)).join("");
  const mutate = (w: string) => {
    const i = Math.floor(r() * (w.length + 1));
    const k = r();
    if (k < 0.33) return w.slice(0, i) + w.slice(i + 1);
    if (k < 0.66) return w.slice(0, i) + pick([...ALPHABET]) + w.slice(i + 1);
    return w.slice(0, i) + pick([...ALPHABET]) + w.slice(i);
  };
  const filler = () => Array.from({ length: Math.floor(r() * 5) }, () => pick([...ALPHABET])).join("");
  const out = new Set<string>();
  while (out.size < n) {
    const parts: string[] = [];
    const count = 1 + Math.floor(r() * 3);
    for (let p = 0; p < count; p++) {
      let w = r() < 0.8 ? pick(words) : filler();
      if (r() < 0.5) w = spell(w);
      if (r() < 0.3) w = mutate(w);
      if (r() < 0.3) w = r() < 0.5 ? filler() + w : w + filler();
      parts.push(w);
    }
    const h = parts
      .join(r() < 0.5 ? "-" : "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(h) && h.length >= 3 && h.length <= 24) out.add(h);
  }
  return [...out];
}

/**
 * Eighth security review, minor 4 (migration 0063): the database's handle rules are packages/core's,
 * word for word and answer for answer.
 */
describe("eighth security review: handle rules, core and database in agreement", () => {
  let db: TestDatabase;
  let pool: pg.Pool;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
  }, 120_000);
  afterAll(async () => {
    await db.drop();
  });

  it("minor 4: the long, short, adjacent and generic word lists are packages/core's", async () => {
    const { rows } = await pool.query<{ l: string[]; s: string[]; a: string[]; g: string[] }>(
      `SELECT core.handle_long_words() AS l, core.handle_short_words() AS s, core.handle_adjacent_words() AS a,
              core.handle_generic_words() AS g`,
    );
    const sorted = (xs: readonly string[] | undefined) => [...(xs ?? [])].sort();
    expect(sorted(rows[0]?.l)).toEqual(sorted(LONG_PROTECTED_HANDLE_WORDS));
    expect(sorted(rows[0]?.s)).toEqual(sorted(SHORT_PROTECTED_HANDLE_WORDS));
    expect(sorted(rows[0]?.a)).toEqual(sorted(ADJACENT_HANDLE_WORDS));
    expect(sorted(rows[0]?.g)).toEqual(sorted(GENERIC_HANDLE_WORDS));
  });

  it("minor 4: the database's short-word forms (table and function) are packages/core's", async () => {
    for (const ligatures of [true, false]) {
      const { rows } = await pool.query<{ t: string[]; f: string[] }>(
        `SELECT (SELECT array_agg(form ORDER BY form) FROM core.handle_short_form WHERE ligatures = $1) AS t,
                (SELECT array_agg(f ORDER BY f) FROM core.handle_short_forms($1) f) AS f`,
        [ligatures],
      );
      const expected = [...shortHandleForms(ligatures)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      expect(rows[0]?.t, `table, ligatures ${ligatures}`).toEqual(expected);
      expect(rows[0]?.f, `function, ligatures ${ligatures}`).toEqual(expected);
    }
  });

  it("minor 4 (shared table): the database's look-alike answer is the table's for every row", async () => {
    const handles = HANDLE_AGREEMENT_CASES.map((c) => c.handle);
    const { rows } = await pool.query<{ h: string; refused: boolean }>(
      "SELECT h, core.handle_lookalike(h) AS refused FROM unnest($1::text[]) h",
      [handles],
    );
    const got = Object.fromEntries(rows.map((r) => [r.h, !r.refused]));
    expect(got).toEqual(Object.fromEntries(HANDLE_AGREEMENT_CASES.map((c) => [c.handle, c.accepted])));
  });

  it(`minor 4 (fuzz): ${FUZZ} generated handles get the same answer from core and the database`, async () => {
    const seed = Number(process.env.HANDLE_FUZZ_SEED ?? 20261122);
    const handles = generate(FUZZ, seed);
    const disagreements: string[] = [];
    for (let i = 0; i < handles.length; i += 500) {
      const batch = handles.slice(i, i + 500);
      const { rows } = await pool.query<{ h: string; look: boolean; prot: boolean }>(
        `SELECT h, core.handle_lookalike(h) AS look, core.handle_protected_lookalike(h) AS prot
           FROM unnest($1::text[]) h`,
        [batch],
      );
      for (const row of rows) {
        if (row.look !== isLookalikeHandle(row.h) || row.prot !== hasProtectedHandleWord(row.h))
          disagreements.push(`${row.h}: db ${row.look}/${row.prot}`);
      }
    }
    expect(disagreements, `seed ${seed}`).toEqual([]);
    // the generator reaches both answers
    const refused = handles.filter((h) => isLookalikeHandle(h)).length;
    expect(refused).toBeGreaterThan(FUZZ / 10);
    expect(refused).toBeLessThan(FUZZ);
  }, 600_000);
});
