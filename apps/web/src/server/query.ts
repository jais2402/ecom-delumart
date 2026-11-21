import "./server-only";
import { z } from "zod";
import { SERVER_CONFIG } from "./config";

/** `limit` (1–50) of the LLD §8.1 pagination, as a number. */
export const limitParam = z
  .string()
  .regex(/^\d{1,3}$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(SERVER_CONFIG.http.pageSizeMax))
  .optional();

/** `?cursor=<uuid>&limit=` */
export const uuidPageQuery = z.object({ cursor: z.uuid().optional(), limit: limitParam });

/** `?cursor=<order reference>&limit=` for the seller's orders (0055: an opaque reference, never an id). */
export const orderRefPageQuery = z.object({
  cursor: z
    .string()
    .regex(/^SO-[A-Z2-9]{16}$/)
    .optional(),
  limit: limitParam,
});

/** `?cursor=<posting id>&limit=` for the statement (posting ids are bigint). */
export const bigintPageQuery = z.object({
  cursor: z
    .string()
    .regex(/^\d{1,19}$/)
    .transform((v) => BigInt(v))
    .optional(),
  limit: limitParam,
});
