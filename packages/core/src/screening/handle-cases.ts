/**
 * The shared table of store handles that keeps validateHandle (this package) and the database's
 * store handle check (core.store_handle_problem, migration 0049) in agreement. Both test suites
 * run every row; `accepted` is the expected answer of both. Well-formed handles only (the format
 * rules are tested separately on each side).
 */
export const HANDLE_AGREEMENT_CASES: readonly { handle: string; accepted: boolean }[] = [
  // the reviewer's look-alikes
  { handle: "de1ulumart", accepted: false },
  { handle: "deluiumart", accepted: false },
  { handle: "admin-team", accepted: false },
  { handle: "support-desk", accepted: false },
  { handle: "official-store", accepted: false },
  // reserved words and folded spellings
  { handle: "admin", accepted: false },
  { handle: "adm1n", accepted: false },
  { handle: "4dmin", accepted: false },
  { handle: "de-lulu", accepted: false },
  { handle: "d3lulu", accepted: false },
  { handle: "5upport", accepted: false },
  { handle: "0fficial", accepted: false },
  { handle: "5h0p", accepted: false },
  { handle: "5t0re", accepted: false },
  { handle: "8ank", accepted: false },
  { handle: "s7aff", accepted: false },
  { handle: "he1p", accepted: false },
  { handle: "my-help-desk", accepted: false },
  { handle: "team-admin", accepted: false },
  { handle: "c0ns0le-x", accepted: false },
  { handle: "delulu-fans", accepted: false },
  // ordinary handles
  { handle: "moon-lamps", accepted: true },
  { handle: "moonlamps", accepted: true },
  { handle: "shopkeeper", accepted: true },
  { handle: "adminx", accepted: true },
  { handle: "lamp-works-7", accepted: true },
  { handle: "the-paw-shoppe", accepted: true },
  { handle: "storey-books", accepted: true },
  { handle: "dream-socks", accepted: true },
];
