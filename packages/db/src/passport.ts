/**
 * Saves, the Inventor Passport and creator access (US-04, US-05; migration 0032), as app_web for
 * the caller's sign-in session. The database derives the actor from the session, verifies the
 * saves and the concept's length itself, and grants the creator entitlement; it takes the quiz
 * result and the concept's screening verdict on the web server's word (see the migration).
 */
import { DomainError } from "@delulu/core";
import type { Pool } from "pg";
import { asPay, asWeb, isUuid, one, requireUuid } from "./command";

export interface SavedProduct {
  saveId: string;
  productId: string;
  savedAt: Date;
  /** False once the product is no longer published; it then has no name or price. */
  published: boolean;
  name: string | null;
  pricePaise: bigint | null;
  sellerName: string | null;
  available: boolean;
  templateId: number | null;
  altText: string | null;
}

export interface PassportProgress {
  ruleVersion: string;
  quiz: { done: boolean; completedAt: Date | null; failedAttempts: number };
  saves: { done: boolean; completedAt: Date | null; count: number; required: number };
  /** The concept text is the owner's own; nobody else can read it. */
  concept: { done: boolean; completedAt: Date | null; text: string | null };
  completedAt: Date | null;
}

export type CreatorSource = "PURCHASE_THRESHOLD" | "ACHIEVEMENT";

export interface CreatorAccess {
  unlocked: boolean;
  source: CreatorSource | null;
  unlockedAt: Date | null;
  ruleVersion: string | null;
  routes: {
    spend: { balancePaise: bigint | null; thresholdPaise: bigint; reached: boolean; reachedAt: Date | null };
    passport: PassportProgress;
  };
}

interface StoredPassport {
  ruleVersion: string;
  quiz: { done: boolean; completedAt: string | null; failedAttempts: number };
  saves: { done: boolean; completedAt: string | null; count: number; required: number };
  concept: { done: boolean; completedAt: string | null; text: string | null };
  completedAt: string | null;
}

interface StoredAccess {
  unlocked: boolean;
  source: CreatorSource | null;
  unlockedAt: string | null;
  ruleVersion: string | null;
  routes: {
    spend: {
      balancePaise: string | null;
      thresholdPaise: string;
      reached: boolean;
      reachedAt: string | null;
    };
    passport: StoredPassport;
  };
}

const date = (v: string | null): Date | null => (v === null ? null : new Date(v));

function passportOf(s: StoredPassport): PassportProgress {
  return {
    ruleVersion: s.ruleVersion,
    quiz: { done: s.quiz.done, completedAt: date(s.quiz.completedAt), failedAttempts: s.quiz.failedAttempts },
    saves: {
      done: s.saves.done,
      completedAt: date(s.saves.completedAt),
      count: Number(s.saves.count),
      required: Number(s.saves.required),
    },
    concept: { done: s.concept.done, completedAt: date(s.concept.completedAt), text: s.concept.text },
    completedAt: date(s.completedAt),
  };
}

// ---------------------------------------------------------------------------- saves

export async function saveProduct(
  pool: Pool,
  input: { authSessionId: string; productId: string },
): Promise<void> {
  requireUuid(input.productId, "productId");
  await asWeb(pool, input.authSessionId, (c) =>
    one(c, "SELECT core.save_product($1) AS r", [input.productId]),
  );
}

export async function unsaveProduct(
  pool: Pool,
  input: { authSessionId: string; productId: string },
): Promise<void> {
  requireUuid(input.productId, "productId");
  await asWeb(pool, input.authSessionId, (c) =>
    one(c, "SELECT core.unsave_product($1) AS r", [input.productId]),
  );
}

export async function mySaves(
  pool: Pool,
  input: { authSessionId: string; cursor?: string | null; pageSize?: number },
): Promise<{ items: SavedProduct[]; nextCursor: string | null }> {
  if (input.cursor != null && !isUuid(input.cursor)) {
    throw new DomainError("VALIDATION_FAILED", "cursor must be a uuid", { field: "cursor" });
  }
  return asWeb(pool, input.authSessionId, async (c) => {
    const { rows } = await c.query<{
      save_id: string;
      product_id: string;
      saved_at: Date;
      published: boolean;
      name: string | null;
      price_paise: string | null;
      seller_name: string | null;
      available: boolean;
      template_id: number | null;
      alt_text: string | null;
    }>(
      `SELECT save_id, product_id, saved_at, published, name, price_paise::text AS price_paise, seller_name,
              available, template_id, alt_text
         FROM core.my_saves($1, $2)`,
      [input.cursor ?? null, input.pageSize ?? null],
    );
    const size = await c.query<{ n: number }>("SELECT core.page_size($1) AS n", [input.pageSize ?? null]);
    const items = rows.map((r) => ({
      saveId: r.save_id,
      productId: r.product_id,
      savedAt: r.saved_at,
      published: r.published,
      name: r.name,
      pricePaise: r.price_paise === null ? null : BigInt(r.price_paise),
      sellerName: r.seller_name,
      available: r.available,
      templateId: r.template_id,
      altText: r.alt_text,
    }));
    const full = items.length === Number(size.rows[0]?.n);
    return { items, nextCursor: full ? (items.at(-1)?.saveId ?? null) : null };
  });
}

// ---------------------------------------------------------------------------- passport

export async function passportProgress(
  pool: Pool,
  input: { authSessionId: string },
): Promise<PassportProgress> {
  const s = await asWeb(pool, input.authSessionId, (c) =>
    one<StoredPassport>(c, "SELECT core.passport_progress() AS r", []),
  );
  return passportOf(s);
}

export interface QuizResult {
  passed: boolean;
  /** Ids of the questions answered wrongly or not at all, in question order (never the right options). */
  wrong: string[];
  ruleVersion: string;
  passport: PassportProgress;
}

/**
 * Submits the quiz answers ({questionId: optionId}); the database grades them against its own
 * answer key for the current rule version (0050) and records a pass or a failed try.
 */
export async function submitPassportQuiz(
  pool: Pool,
  input: { authSessionId: string; answers: Readonly<Record<string, string>> },
): Promise<QuizResult> {
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<{ passed: boolean; wrong: string[]; ruleVersion: string; passport: StoredPassport }>(
      c,
      "SELECT core.passport_submit_quiz($1::jsonb) AS r",
      [JSON.stringify(input.answers)],
    ),
  );
  return {
    passed: r.passed === true,
    wrong: r.wrong.map(String),
    ruleVersion: String(r.ruleVersion),
    passport: passportOf(r.passport),
  };
}

/**
 * Submits the invention concept with the web server's screening verdict; the database stores it
 * only when the verdict is 'OK' and the length is within the rules. Runs as app_pay (0050): only the
 * pay credential may store text on the strength of the server's screening.
 */
export async function submitPassportConcept(
  pool: Pool,
  input: { authSessionId: string; concept: string; screening: "OK" | "NEEDS_REVIEW" | "REJECT" },
): Promise<PassportProgress> {
  const s = await asPay(pool, input.authSessionId, (c) =>
    one<StoredPassport>(c, "SELECT core.passport_submit_concept($1, $2) AS r", [
      input.concept,
      input.screening,
    ]),
  );
  return passportOf(s);
}

export async function creatorAccess(pool: Pool, input: { authSessionId: string }): Promise<CreatorAccess> {
  const s = await asWeb(pool, input.authSessionId, (c) =>
    one<StoredAccess>(c, "SELECT core.creator_access() AS r", []),
  );
  return {
    unlocked: s.unlocked,
    source: s.source,
    unlockedAt: date(s.unlockedAt),
    ruleVersion: s.ruleVersion,
    routes: {
      spend: {
        balancePaise: s.routes.spend.balancePaise === null ? null : BigInt(s.routes.spend.balancePaise),
        thresholdPaise: BigInt(s.routes.spend.thresholdPaise),
        reached: s.routes.spend.reached,
        reachedAt: date(s.routes.spend.reachedAt),
      },
      passport: passportOf(s.routes.passport),
    },
  };
}
