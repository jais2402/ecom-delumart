/**
 * The shared table of handles that keeps validateHandle (this package) and the database's handle
 * checks (core.store_handle_problem for store handles, core.update_profile for user handles;
 * migrations 0049 and 0056) in agreement. Both test suites run every row; `accepted` is the
 * expected answer of all of them. Well-formed handles only (the format rules are tested separately
 * on each side).
 *
 * Since the seventh security review (minor 4): a PROTECTED word (the brand and authority words)
 * is refused anywhere in the folded handle; a GENERIC word only as the whole handle, leading and
 * trailing digits ignored.
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
  // generic words refuse only as the whole handle (seventh review: these were refused as tokens)
  { handle: "my-help-desk", accepted: true },
  { handle: "team-admin", accepted: false },
  { handle: "c0ns0le-x", accepted: true },
  { handle: "delulu-fans", accepted: false },
  // the seventh review's look-alikes: rn for m, repeated letters, protected words anywhere, digits
  { handle: "delulurnart", accepted: false },
  { handle: "adrnin", accepted: false },
  { handle: "delulumart2", accepted: false },
  { handle: "admin1", accepted: false },
  { handle: "1admin", accepted: false },
  { handle: "deluluofficial", accepted: false },
  { handle: "officialdelulu", accepted: false },
  { handle: "de1ulumartofficial", accepted: false },
  { handle: "dellulumart", accepted: false },
  { handle: "deluluuu", accepted: false },
  { handle: "moderatornews", accepted: false },
  { handle: "superadmin-x", accepted: false },
  { handle: "the-security-team", accepted: false },
  { handle: "verifiedseller", accepted: false },
  { handle: "staffpicks", accepted: false },
  { handle: "mysystem", accepted: false },
  { handle: "shop1", accepted: false },
  { handle: "2024-shop", accepted: false },
  { handle: "api7", accepted: false },
  { handle: "ssshop", accepted: false },
  // the seventh review's wrongly refused handles: a generic word is fine inside a longer handle
  { handle: "cake-shop", accepted: true },
  { handle: "acme-store", accepted: true },
  { handle: "root-beer", accepted: true },
  { handle: "pay-day", accepted: true },
  { handle: "api-studio", accepted: true },
  { handle: "shop-of-moons", accepted: true },
  { handle: "help-the-bees", accepted: true },
  // ordinary handles
  { handle: "moon-lamps", accepted: true },
  { handle: "moonlamps", accepted: true },
  { handle: "shopkeeper", accepted: true },
  { handle: "adminx", accepted: false }, // seventh review: a protected word anywhere
  { handle: "lamp-works-7", accepted: true },
  { handle: "the-paw-shoppe", accepted: true },
  { handle: "storey-books", accepted: true },
  { handle: "dream-socks", accepted: true },
];
