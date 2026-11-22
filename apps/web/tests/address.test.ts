import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as addressDefault from "../src/app/api/v1/addresses/[id]/default/route";
import * as addressOne from "../src/app/api/v1/addresses/[id]/route";
import * as addresses from "../src/app/api/v1/addresses/route";
import * as checkoutSession from "../src/app/api/v1/checkout-sessions/[id]/route";
import * as brandProgress from "../src/app/api/v1/studio/brand-progress/route";
import * as earnings from "../src/app/api/v1/studio/earnings/route";
import * as inventory from "../src/app/api/v1/studio/inventory/route";
import * as studioOrder from "../src/app/api/v1/studio/orders/[id]/route";
import * as studioOrders from "../src/app/api/v1/studio/orders/route";
import { startTestApp, type TestApp } from "./helpers/app";
import { arr, Browser, str } from "./helpers/browser";
import { player, R } from "./helpers/flows";
import { aMinuteLater, publishedListing, seller } from "./helpers/studio";

/** PRD R5.2 delivery addresses through the routes (migration 0058). */
let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ env: { RATE_LIMIT_MULTIPLIER: "5" } });
}, 120_000);

afterAll(async () => {
  await app.stop();
});

const HOME = {
  recipientName: "Asha Rao",
  line1: "Flat 4B, Sai Krupa Apartments",
  line2: "12/3, 2nd Cross, Indiranagar",
  city: "Bengaluru",
  state: "KA",
  postalCode: "560038",
  country: "IN",
};

/** Realistic Indian addresses: slashes, commas, c/o, flat and house numbers, Devanagari. */
const REALISTIC = [
  HOME,
  {
    recipientName: "R. K. Sharma",
    line1: "c/o Mrs. Meena Sharma, H.No. 1-2-345/A",
    line2: "Near Old Water Tank, Ward No. 7",
    city: "Hyderabad",
    state: "TS",
    postalCode: "500 029",
    country: "IN",
  },
  {
    recipientName: "D'Souza Family",
    line1: "B-302, Sea Breeze CHS, Plot No. 14, Sector 17",
    city: "Navi Mumbai",
    state: "MH",
    postalCode: "400703",
    country: "IN",
  },
  {
    recipientName: "अमित कुमार",
    line1: "मकान नं. 45, गली नं. 3",
    line2: "लाजपत नगर - IV",
    city: "नई दिल्ली",
    state: "DL",
    postalCode: "110024",
    country: "IN",
  },
  {
    recipientName: "Priya (Work)",
    line1: "4th Floor, Tower C; DLF Cyber City Phase-II",
    line2: "Opp. Ambience Mall & Food Court #2",
    city: "Gurugram",
    state: "HR",
    postalCode: "122002",
    country: "IN",
  },
];

const add = (b: Browser, body: unknown) => b.call(addresses.POST, "POST", "/api/v1/addresses", { body });
const list = (b: Browser) => b.call(addresses.GET, "GET", "/api/v1/addresses");
const patch = (b: Browser, id: string, body: unknown) =>
  b.call(addressOne.PATCH, "PATCH", `/api/v1/addresses/${id}`, { params: { id }, body });
const remove = (b: Browser, id: string) =>
  b.call(addressOne.DELETE, "DELETE", `/api/v1/addresses/${id}`, { params: { id } });
const makeDefault = (b: Browser, id: string) =>
  b.call(addressDefault.POST, "POST", `/api/v1/addresses/${id}/default`, { params: { id } });

async function payFor(b: Browser, sessionId: string): Promise<string> {
  const attempt = await b.call(R.attempts.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/attempts`, {
    params: { id: sessionId },
    body: { method: "BALANCE" },
  });
  expect(attempt.status).toBe(201);
  const paid = await b.call(R.pay.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/pay`, {
    params: { id: sessionId },
    body: { attemptId: str(attempt.json.id) },
    idempotencyKey: true,
  });
  expect(paid.status).toBe(200);
  return str(paid.json.orderId);
}

const quote = (b: Browser, productId: string, extra: Record<string, unknown> = {}) =>
  b.call(R.checkoutSessions.POST, "POST", "/api/v1/checkout-sessions", {
    body: { lines: [{ productId }], speedBySeller: { SEED: "STANDARD" }, ...extra },
    idempotencyKey: true,
  });

const getOrder = (b: Browser, id: string) =>
  b.call(R.order.GET, "GET", `/api/v1/orders/${id}`, { params: { id } });

describe("address book routes (PRD R5.2)", () => {
  it("R5.2: realistic Indian addresses are saved, listed decrypted for the owner only, and every response is private", async () => {
    const { b } = await player({ pin: false });
    const ids: string[] = [];
    for (const [i, address] of REALISTIC.entries()) {
      const res = await add(b, { label: i === 1 ? "WORK" : "HOME", address });
      expect(res.status, address.line1).toBe(201);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      ids.push(str(res.json.id));
    }
    const res = await list(b);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(arr(res.json.items)).toHaveLength(5);
    expect(res.json.max).toBe(5);
    expect(arr(res.json.items)[0]).toMatchObject({
      id: ids[0],
      isDefault: true,
      label: "HOME",
      labelName: "Home",
    });
    expect(arr(res.json.items)[0]?.text).toBe(
      "Asha Rao, Flat 4B, Sai Krupa Apartments, 12/3, 2nd Cross, Indiranagar, Bengaluru, Karnataka 560038",
    );
    expect(arr(res.json.items).find((x) => x.id === ids[1])?.address?.postalCode).toBe("500029");
    // a sixth is ADDRESS_LIMIT (409)
    const sixth = await add(b, { label: "OTHER", address: HOME });
    expect(sixth.status).toBe(409);
    expect(sixth.json.error?.code).toBe("ADDRESS_LIMIT");
    // another player sees none of them
    const other = await player({ pin: false });
    expect(arr((await list(other.b)).json.items)).toEqual([]);
  });

  it("R5.2: the database receives ciphertext only (no plaintext field in any column)", async () => {
    const { b } = await player({ pin: false });
    expect(
      (await add(b, { label: "HOME", address: { ...HOME, line2: "Uniquely Named Lane 77" } })).status,
    ).toBe(201);
    const { rows } = await app.db.pool.query<{ j: string; p: Buffer }>(
      "SELECT to_jsonb(a)::text AS j, payload_enc AS p FROM private.address a",
    );
    for (const r of rows) {
      expect(r.j).not.toMatch(/Uniquely|Indiranagar|560038|Bengaluru|Asha/);
      expect(r.p.toString("latin1")).not.toMatch(/Uniquely|Indiranagar|560038|Bengaluru|Asha/);
      expect(r.p[0]).toBe(1); // key id
    }
  });

  it("R5.2: format is checked; abuse (links, email, phone or card numbers) is refused without echoing the text", async () => {
    const { b } = await player({ pin: false });
    const bad = await add(b, { label: "HOME", address: { ...HOME, postalCode: "56003" } });
    expect(bad.status).toBe(422);
    expect(bad.json.error).toMatchObject({ code: "VALIDATION_FAILED", details: { field: "postalCode" } });
    for (const line2 of [
      "mail me at asha@example.com",
      "see www.example.com",
      "call 98450 12345",
      "4111 1111 1111 1111",
    ]) {
      const res = await add(b, { label: "HOME", address: { ...HOME, line2 } });
      expect(res.status, line2).toBe(422);
      expect(res.json.error?.code).toBe("VALIDATION_FAILED");
      expect(JSON.stringify(res.json)).not.toContain(line2);
    }
    // unknown fields (a phone, a landmark, a card) and unknown labels are malformed requests
    for (const body of [
      { label: "HOME", address: { ...HOME, phone: "9845012345" } },
      { label: "HOME", address: { ...HOME, landmark: "near the temple" } },
      { label: "HOME", address: HOME, cardNumber: "4111111111111111" },
      { label: "HOUSE", address: HOME },
      { label: "HOME", address: { ...HOME, country: "US" } },
    ]) {
      expect((await add(b, body)).status).toBe(400);
    }
    expect(arr((await list(b)).json.items)).toEqual([]);
  });

  it("R5.2: edit, set default and delete; deleting the default promotes the most recent", async () => {
    const { b } = await player({ pin: false });
    const first = str((await add(b, { label: "HOME", address: HOME })).json.id);
    const second = str((await add(b, { label: "WORK", address: REALISTIC[2] })).json.id);
    const edited = await patch(b, second, { label: "OTHER", address: { ...REALISTIC[2], line2: "Tower 2" } });
    expect(edited.status).toBe(200);
    expect(edited.json).toMatchObject({ label: "OTHER", address: { line2: "Tower 2" } });
    const relabel = await patch(b, first, { label: "WORK" });
    expect(relabel.json).toMatchObject({ label: "WORK", address: { line1: HOME.line1 } });
    expect((await patch(b, first, {})).status).toBe(400);
    const def = await makeDefault(b, second);
    expect(def.status).toBe(200);
    expect(def.json.isDefault).toBe(true);
    const gone = await remove(b, second);
    expect(gone.status).toBe(200);
    expect(gone.json).toEqual({ deletedId: second, defaultAddressId: first });
    expect(arr((await list(b)).json.items).map((x) => x.id)).toEqual([first]);
  });

  it("IDOR: another player's address is ADDRESS_NOT_FOUND (404) for edit, delete, default and checkout", async () => {
    const owner = await player({ pin: false });
    const theirs = str((await add(owner.b, { label: "HOME", address: HOME })).json.id);
    const { b } = await player({ pin: false });
    for (const res of [
      await patch(b, theirs, { label: "WORK" }),
      await remove(b, theirs),
      await makeDefault(b, theirs),
      await quote(b, app.products[0]?.id ?? "", { addressId: theirs }),
    ]) {
      expect(res.status).toBe(404);
      expect(res.json.error?.code).toBe("ADDRESS_NOT_FOUND");
    }
    const s = await quote(b, app.products[0]?.id ?? "");
    const sessionId = str(s.json.id);
    const steer = await b.call(checkoutSession.PATCH, "PATCH", `/api/v1/checkout-sessions/${sessionId}`, {
      params: { id: sessionId },
      body: { addressId: theirs },
    });
    expect(steer.status).toBe(404);
    expect(steer.json.error?.code).toBe("ADDRESS_NOT_FOUND");
    expect((await patch(b, "not-a-uuid", { label: "WORK" })).status).toBe(404);
    // nobody can change someone else's checkout session either
    const os = await quote(owner.b, app.products[0]?.id ?? "");
    const osId = str(os.json.id);
    const hijack = await b.call(checkoutSession.PATCH, "PATCH", `/api/v1/checkout-sessions/${osId}`, {
      params: { id: osId },
      body: { deliverTo: "FICTIONAL_SPOT" },
    });
    expect(hijack.status).toBe(404);
    // unchanged for the owner
    expect(arr((await list(owner.b)).json.items)[0]).toMatchObject({ id: theirs, label: "HOME" });
  });

  it("needs a session, the Origin and the session's CSRF token", async () => {
    const anon = new Browser();
    const token = await anon.call(R.csrf.GET, "GET", "/api/v1/auth/csrf");
    anon.csrfToken = str(token.json.csrfToken);
    expect((await list(anon)).status).toBe(401);
    expect((await add(anon, { label: "HOME", address: HOME })).status).toBe(401);
    const { b } = await player({ pin: false });
    const opts = [
      { csrf: false as const },
      { csrf: "wrong-token" },
      { origin: "https://evil.example" },
      { origin: null },
    ];
    for (const o of opts) {
      const res = await b.call(addresses.POST, "POST", "/api/v1/addresses", {
        body: { label: "HOME", address: HOME },
        ...o,
      });
      expect(res.status).toBe(403);
    }
  });
});

describe("checkout and orders with an address (PRD R5.2, decisions.md #4)", () => {
  const consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
  const logged: string[] = [];
  afterEach(() => {
    for (const s of consoleSpies.splice(0)) s.mockRestore();
  });
  function captureLogs(): void {
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      consoleSpies.push(
        vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
          logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
        }),
      );
    }
  }

  it("R5.2: no choice is the fictional spot; a saved address is shown on the buyer's order; edit keeps the order's copy; delete leaves 'Address removed'", async () => {
    captureLogs();
    const { b } = await player({ pin: false });
    const [p1, p2, p3] = app.products;
    // the default: a fictional spot
    const fictional = await payFor(b, str((await quote(b, p1?.id ?? "")).json.id));
    const f = await getOrder(b, fictional);
    expect(f.json.delivery).toMatchObject({ kind: "FICTIONAL_SPOT" });
    expect(typeof f.json.delivery?.text).toBe("string");

    const home = str(
      (await add(b, { label: "HOME", address: { ...HOME, line2: "Marker Lane 4242" } })).json.id,
    );
    const work = str((await add(b, { label: "WORK", address: REALISTIC[2] })).json.id);
    // chosen on the open session (PATCH), after a quote made for another address
    const s = await quote(b, p2?.id ?? "", { addressId: work });
    expect(s.status).toBe(201);
    const sessionId = str(s.json.id);
    const steer = await b.call(checkoutSession.PATCH, "PATCH", `/api/v1/checkout-sessions/${sessionId}`, {
      params: { id: sessionId },
      body: { addressId: home },
    });
    expect(steer.status).toBe(200);
    expect(steer.headers.get("cache-control")).toBe("private, no-store");
    expect(steer.json).toEqual({ sessionId, deliverTo: "ADDRESS", addressId: home });
    // the price is the same as without an address
    const plain = await quote(b, p2?.id ?? "");
    expect(plain.json.totalPaise).toBe(s.json.totalPaise);
    const orderId = await payFor(b, sessionId);
    const o = await getOrder(b, orderId);
    expect(o.headers.get("cache-control")).toBe("private, no-store");
    expect(o.json.delivery).toEqual({
      kind: "ADDRESS",
      label: "HOME",
      labelName: "Home",
      text: "Asha Rao, Flat 4B, Sai Krupa Apartments, Marker Lane 4242, Bengaluru, Karnataka 560038",
    });
    // another player cannot open the order
    const other = await player({ pin: false });
    expect((await getOrder(other.b, orderId)).status).toBe(404);
    // an edit does not change the order
    expect((await patch(b, home, { address: { ...HOME, line2: "Edited Lane 1" } })).status).toBe(200);
    expect((await getOrder(b, orderId)).json.delivery?.text).toContain("Marker Lane 4242");
    // a delete removes it from the order too
    expect((await remove(b, home)).status).toBe(200);
    expect((await getOrder(b, orderId)).json.delivery).toEqual({ kind: "ADDRESS_REMOVED" });
    // and a session pointed at a deleted address refuses to pay, moving nothing
    const s3 = await quote(b, p3?.id ?? "", { addressId: work });
    const s3Id = str(s3.json.id);
    expect((await remove(b, work)).status).toBe(200);
    const attempt = await b.call(R.attempts.POST, "POST", `/api/v1/checkout-sessions/${s3Id}/attempts`, {
      params: { id: s3Id },
      body: { method: "BALANCE" },
    });
    const refused = await b.call(R.pay.POST, "POST", `/api/v1/checkout-sessions/${s3Id}/pay`, {
      params: { id: s3Id },
      body: { attemptId: str(attempt.json.id) },
      idempotencyKey: true,
    });
    expect(refused.json.error?.code).toBe("ADDRESS_NOT_FOUND");

    // invariant 8: nothing logged, and no outbox, audit or analytics row, carries the address
    const needles = [
      "Marker Lane",
      "Edited Lane",
      "Indiranagar",
      "Sai Krupa",
      "560038",
      "Sea Breeze",
      "400703",
    ];
    for (const line of logged) for (const n of needles) expect(line).not.toContain(n);
    const tables = await app.db.pool.query<{ t: string }>(
      `SELECT format('%I.%I', n.nspname, c.relname) AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('audit', 'analytics', 'research')`,
    );
    for (const { t } of tables.rows) {
      const rows = await app.db.pool.query<{ j: string }>(`SELECT to_jsonb(x)::text AS j FROM ${t} x`);
      for (const r of rows.rows) for (const n of [...needles, "payloadEnc"]) expect(r.j, t).not.toContain(n);
    }
  });

  it("checkout create accepts deliverTo FICTIONAL_SPOT, but not together with an addressId", async () => {
    const { b } = await player({ pin: false });
    const id = str((await add(b, { label: "HOME", address: HOME })).json.id);
    expect((await quote(b, app.products[0]?.id ?? "", { deliverTo: "FICTIONAL_SPOT" })).status).toBe(201);
    expect(
      (await quote(b, app.products[0]?.id ?? "", { deliverTo: "FICTIONAL_SPOT", addressId: id })).status,
    ).toBe(400);
    expect((await quote(b, app.products[0]?.id ?? "", { deliverTo: "MOON" })).status).toBe(400);
  });

  it("R5.2: no seller-facing route carries the buyer's address, label, PIN code or ciphertext", async () => {
    const s = await seller(app);
    const listingId = await publishedListing(s.b, { quantity: 2 });
    const { b } = await player({ pin: false });
    const home = str(
      (await add(b, { label: "HOME", address: { ...HOME, line2: "Seller Must Not See 9" } })).json.id,
    );
    const q = await b.call(R.checkoutSessions.POST, "POST", "/api/v1/checkout-sessions", {
      body: {
        lines: [{ productId: listingId }],
        speedBySeller: { [s.companyId]: "STANDARD" },
        addressId: home,
      },
      idempotencyKey: true,
    });
    expect(q.status).toBe(201);
    await payFor(b, str(q.json.id));
    await aMinuteLater(app); // 0060: a seller sees an order once its minute has ended
    const orders = await s.b.call(studioOrders.GET, "GET", "/api/v1/studio/orders");
    expect(orders.status).toBe(200);
    const ref = str(
      orders.json.items?.[0]?.orderRef ?? orders.json.items?.[0]?.reference ?? orders.json.items?.[0]?.id,
    );
    const reads = [
      orders,
      await s.b.call(studioOrder.GET, "GET", `/api/v1/studio/orders/${ref}`, { params: { id: ref } }),
      await s.b.call(earnings.GET, "GET", "/api/v1/studio/earnings"),
      await s.b.call(inventory.GET, "GET", "/api/v1/studio/inventory"),
      await s.b.call(brandProgress.GET, "GET", "/api/v1/studio/brand-progress"),
    ];
    for (const r of reads) {
      expect(r.status).toBe(200);
      const text = JSON.stringify(r.json);
      for (const n of [
        "Seller Must Not See",
        "Indiranagar",
        "560038",
        "Bengaluru",
        "Karnataka",
        home,
        "address",
        "HOME",
      ]) {
        expect(text).not.toContain(n);
      }
    }
    // every response the seller's browser saw
    for (const seen of s.b.seen) expect(seen).not.toContain("Seller Must Not See");
  });
});
