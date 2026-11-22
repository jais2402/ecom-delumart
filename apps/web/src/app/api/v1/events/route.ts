import { amountBucket, itemCount, queryLengthBucket, resultCountBucket, SURFACES } from "@delulu/core";
import { z } from "zod";
import { declinesTracking, type EventProps, track } from "@/server/analytics";
import { readCappedText } from "@/server/body";
import { clientAddress } from "@/server/client-address";
import { SERVER_CONFIG } from "@/server/config";
import { env } from "@/server/env";
import { PRIVATE_CACHE } from "@/server/http";
import { enforceRate, RATE_RULES } from "@/server/rate-limit";
import { readSessionId } from "@/server/session";

/**
 * POST /api/v1/events {name, surface, props}: a browser-originated analytics event (page_view,
 * search, product_view, cart_add, checkout_start only; PRD R16.5). Always answers 204 with
 * `private, no-store`, whatever happened, so the browser learns nothing from it. Recorded only when
 * the Origin is the app's, the client sends neither Sec-GPC: 1 nor DNT: 1, the per-address rate
 * limit allows it and the body is exactly one of the shapes below: no identity, place, address or
 * free text is accepted (strict objects; the search query itself is never sent, only its length
 * and result count, which are bucketed here). Purchases, sign-ups, unlocks, shops and listings are
 * recorded by the server, never from here. The body is capped (`maxEventBytes`): a larger
 * Content-Length is refused before reading, and the read stops as soon as the cap is passed.
 */
const surface = z.enum(SURFACES);
const uuid = z.uuid().transform((v) => v.toLowerCase());

const body = z.discriminatedUnion("name", [
  z.strictObject({ name: z.literal("page_view"), surface, props: z.strictObject({}).optional() }),
  z.strictObject({
    name: z.literal("search"),
    surface,
    props: z.strictObject({
      resultCount: z.int().min(0).max(1_000_000),
      queryLength: z.int().min(0).max(1_000),
    }),
  }),
  z.strictObject({ name: z.literal("product_view"), surface, props: z.strictObject({ productId: uuid }) }),
  z.strictObject({ name: z.literal("cart_add"), surface, props: z.strictObject({ productId: uuid }) }),
  z.strictObject({
    name: z.literal("checkout_start"),
    surface,
    props: z.strictObject({
      itemCount: z.int().min(1).max(1_000),
      totalPaise: z
        .string()
        .regex(/^\d{1,15}$/)
        .optional(),
    }),
  }),
]);

type EventBody = z.infer<typeof body>;

function propsOf(e: EventBody): EventProps {
  switch (e.name) {
    case "page_view":
      return {};
    case "search":
      return {
        result_count_bucket: resultCountBucket(e.props.resultCount),
        query_length_bucket: queryLengthBucket(e.props.queryLength),
      };
    case "product_view":
    case "cart_add":
      return { product_id: e.props.productId };
    case "checkout_start":
      return {
        item_count: itemCount(e.props.itemCount),
        ...(e.props.totalPaise === undefined
          ? {}
          : { amount_bucket: amountBucket(BigInt(e.props.totalPaise)) }),
      };
  }
}

const UUID = z.uuid();

async function accept(request: Request): Promise<void> {
  const config = env();
  if (request.headers.get("origin") !== config.appOrigin) return;
  if (config.analyticsKey === null || declinesTracking(request.headers)) return;
  await enforceRate(RATE_RULES.eventsAddress, clientAddress(request, config.trustedProxyHops));
  const text = await readCappedText(request, SERVER_CONFIG.analytics.maxEventBytes);
  if (text === null) return;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return;
  }
  const parsed = body.safeParse(json);
  if (!parsed.success) return;
  // the cookie's session, unchecked: the database derives the actor from it (or nobody)
  const cookie = readSessionId(request, config.appOrigin);
  await track(request, parsed.data.name, propsOf(parsed.data), {
    surface: parsed.data.surface,
    authSessionId: cookie !== null && UUID.safeParse(cookie).success ? cookie.toLowerCase() : null,
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    await accept(request);
  } catch {
    // RATE_LIMITED or the database unavailable: nothing recorded, nothing said
  }
  return new Response(null, { status: 204, headers: { "cache-control": PRIVATE_CACHE } });
}
