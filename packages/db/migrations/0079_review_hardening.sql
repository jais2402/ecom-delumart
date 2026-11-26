-- Ratings and reviews, review round 1 (docs/decisions.md #14). 0078 is never edited.
--
-- M1 / minor 1. The database backstop of a review's text (core.review_check_input) now also
--   refuses what the web server's screening (packages/core/src/screening) refuses since this round:
--     * format and separator characters (Unicode Cf: zero-width spaces and joiners, bidi
--       controls, BOM, soft hyphen, word joiner, ...; Zl; Zp), except a ZWJ or ZWNJ written right
--       after an Indic letter or sign (U+0900-U+0DFF), where it is ordinary writing;
--     * digit runs of ten or more in any common script: Devanagari, Bengali, Gurmukhi, Gujarati,
--       Oriya, Tamil, Telugu, Kannada, Malayalam, Arabic-Indic, Extended Arabic-Indic and fullwidth
--       digits are translated to ASCII before the digit-run check;
--     * any dotted domain-like word ("evil.ru": a letter and at least one more character, a dot,
--       two or more letters; a full stop followed by a space, and a one-letter abbreviation such as
--       "H.No.", are prose) and a spelled-out address with a path ("evil dot ru slash x").
-- Minor 3. Every review tunable is read through core.review_limit(key), clamped to [1, the table's
--   or page's ceiling], so no configuration can divide by zero or exceed a column. Its defaults
--   equal REVIEW_RULES in packages/core/src/review (the one source; a db test compares them), and
--   refusal messages are built from the values.
-- Minor 4. A review is public only from the reporting day (Asia/Kolkata, core.company_time_zone)
--   after the one it was written in: core.review_public_before() is the start of the current
--   reporting day, and core.review_is_public requires created_at before it. This replaces the
--   purchase-minute rule of 0078 (which it implies) and decouples a review from its order's time:
--   nobody can learn from a review more than the day it was written. The author sees their own at
--   once ("public": false until then). Tests move a review's created_at back as the owner; no
--   application role can.

-- ---------------------------------------------------------------- configuration (minor 3)
CREATE FUNCTION core.review_limit(p_key text) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT GREATEST(1, LEAST(core.config_int(core.current_config_id(), ARRAY[p_key], d.dflt), d.ceiling))::int
    FROM (VALUES ('review_title_max_chars', 80, 200),
                 ('review_body_max_chars', 1000, 4000),
                 ('review_page_size', 10, 50),
                 ('review_admin_page_size', 20, 50),
                 ('review_summary_max', 100, 100)) AS d(key, dflt, ceiling)
   WHERE d.key = p_key
$$;

-- ---------------------------------------------------------------- the text backstop (M1, minor 1)
-- Decimal digits of the common scripts, in blocks of ten from 0 to 9.
CREATE FUNCTION core.ascii_digits(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT translate(p,
    '०१२३४५६७८९০১২৩৪৫৬৭৮৯੦੧੨੩੪੫੬੭੮੯૦૧૨૩૪૫૬૭૮૯୦୧୨୩୪୫୬୭୮୯௦௧௨௩௪௫௬௭௮௯౦౧౨౩౪౫౬౭౮౯೦೧೨೩೪೫೬೭೮೯൦൧൨൩൪൫൬൭൮൯٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹０１２３４５６７８９',
    repeat('0123456789', 12))
$$;

-- Format (Cf) and line or paragraph separator characters, a ZWJ or ZWNJ after an Indic character excepted.
CREATE FUNCTION core.has_invisible(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT regexp_replace(p, '([ऀ-෿])[‌‍]', '\1', 'g')
         ~ '[­؀-؅؜۝܏࢐࢑࣢᠎​-‏‪-‮⁠-⁤⁦-⁯  ﻿￹-￻\U000110BD\U000110CD\U00013430-\U0001343F\U0001BCA0-\U0001BCA3\U0001D173-\U0001D17A\U000E0001\U000E0020-\U000E007F]'
$$;

CREATE OR REPLACE FUNCTION core.review_check_input(p_rating int, p_title text, p_body text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_title_max int := core.review_limit('review_title_max_chars');
  v_body_max  int := core.review_limit('review_body_max_chars');
  v_text      text;
BEGIN
  IF p_rating IS NULL OR p_rating NOT BETWEEN 1 AND 5 THEN
    PERFORM core.fail('REVIEW_INVALID', 'a rating is a whole number from 1 to 5');
  END IF;
  IF p_title IS NOT NULL AND (char_length(p_title) > v_title_max OR p_title ~ '[[:cntrl:]]') THEN
    PERFORM core.fail('REVIEW_INVALID', format('a title is at most %s characters on one line', v_title_max));
  END IF;
  IF p_body IS NOT NULL AND (char_length(p_body) > v_body_max OR replace(p_body, E'\n', '') ~ '[[:cntrl:]]') THEN
    PERFORM core.fail('REVIEW_INVALID', format('a review is at most %s characters', v_body_max));
  END IF;
  v_text := COALESCE(p_title, '') || E'\n' || COALESCE(p_body, '');
  IF core.has_invisible(v_text) THEN
    PERFORM core.fail('REVIEW_INVALID', 'a review may not contain invisible or formatting characters');
  END IF;
  v_text := core.ascii_digits(v_text);
  IF v_text ~* '(https?://|www\.)' OR v_text ~ '[^[:space:]@]+@[^[:space:]@]+\.[[:alpha:]]{2,}'
     OR v_text ~ '[[:alpha:]][[:alnum:]-]+\.[[:alpha:]]{2}'
     OR v_text ~* '\mdot\s+[[:alpha:]]{2,3}\s+slash\M'
     OR EXISTS (SELECT 1 FROM regexp_matches(v_text, '([0-9][0-9 ().+/-]*)', 'g') m
                 WHERE char_length(regexp_replace(m[1], '[^0-9]', '', 'g')) >= 10) THEN
    PERFORM core.fail('REVIEW_INVALID', 'a review may not contain links, contact details or long numbers');
  END IF;
END $$;

-- ---------------------------------------------------------------- next-day visibility (minor 4)
-- The start of the current reporting day: reviews written before it are public.
CREATE FUNCTION core.review_public_before() RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT date_trunc('day', clock_timestamp() AT TIME ZONE core.company_time_zone(NULL::uuid))
         AT TIME ZONE core.company_time_zone(NULL::uuid)
$$;

CREATE OR REPLACE FUNCTION core.review_is_public(r core.product_review) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT r.status = 'PUBLISHED' AND NOT r.hidden
     AND r.created_at < core.review_public_before()
     AND EXISTS (SELECT 1 FROM core.user_profile up WHERE up.id = r.user_id AND up.status = 'ACTIVE')
     AND EXISTS (SELECT 1 FROM core.product p WHERE p.id = r.product_id AND p.status = 'PUBLISHED')
     AND EXISTS (SELECT 1 FROM core.ownership o
                  WHERE o.user_id = r.user_id AND o.product_id = r.product_id AND o.state = 'ACTIVE')
$$;

-- ---------------------------------------------------------------- reads with clamped sizes (minor 3)
CREATE OR REPLACE FUNCTION core.product_reviews(p_product uuid, p_page int) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_size   int := core.review_limit('review_page_size');
  v_page   int := COALESCE(p_page, 1);
  v_count  bigint;
  v_sum    bigint;
  v_dist   jsonb;
  v_items  jsonb;
BEGIN
  IF v_page < 1 OR v_page > 10000 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'page is a whole number from 1');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.product p
                  WHERE p.id = p_product AND p.status = 'PUBLISHED' AND p.current_version_id IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  -- one statement, each review judged once: the count, the bars and the page always agree
  WITH vis AS MATERIALIZED (
    SELECT r.* FROM core.product_review r
     WHERE r.product_id = p_product AND r.status = 'PUBLISHED' AND core.review_is_public(r)),
  pg AS (
    SELECT v.* FROM vis v ORDER BY v.created_at DESC, v.id DESC OFFSET (v_page - 1) * v_size LIMIT v_size)
  SELECT (SELECT count(*) FROM vis),
         (SELECT COALESCE(sum(v.rating), 0) FROM vis v),
         (SELECT jsonb_build_array(count(*) FILTER (WHERE v.rating = 1), count(*) FILTER (WHERE v.rating = 2),
                                   count(*) FILTER (WHERE v.rating = 3), count(*) FILTER (WHERE v.rating = 4),
                                   count(*) FILTER (WHERE v.rating = 5)) FROM vis v),
         (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                   'rating', x.rating, 'title', x.title, 'body', x.body,
                   'handle', (SELECT up.handle FROM core.user_profile up WHERE up.id = x.user_id),
                   'createdOn', to_char((x.created_at AT TIME ZONE core.company_time_zone(
                                  (SELECT p.company_id FROM core.product p WHERE p.id = x.product_id)))::date,
                                'YYYY-MM-DD'),
                   'edited', x.version > 1)
                 ORDER BY x.created_at DESC, x.id DESC), '[]'::jsonb) FROM pg x)
    INTO v_count, v_sum, v_dist, v_items;
  RETURN jsonb_build_object(
    'productId', p_product, 'count', v_count, 'ratingSum', v_sum,
    'averageTenths', CASE WHEN v_count = 0 THEN 0 ELSE (20 * v_sum + v_count) / (2 * v_count) END,
    'distribution', v_dist, 'items', v_items, 'page', v_page, 'pageSize', v_size,
    'totalPages', (v_count + v_size - 1) / v_size);
END $$;

CREATE OR REPLACE FUNCTION core.product_review_summaries(p_products uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_products IS NULL OR cardinality(p_products) > core.review_limit('review_summary_max') THEN
    PERFORM core.fail('VALIDATION_FAILED', format('at most %s products', core.review_limit('review_summary_max')));
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'productId', s.id, 'count', s.n, 'ratingSum', s.total,
             'averageTenths', CASE WHEN s.n = 0 THEN 0 ELSE (20 * s.total + s.n) / (2 * s.n) END)
           ORDER BY s.id)
      FROM (SELECT p.id, count(r.id) AS n, COALESCE(sum(r.rating), 0) AS total
              FROM core.product p
              LEFT JOIN core.product_review r
                ON r.product_id = p.id AND r.status = 'PUBLISHED' AND core.review_is_public(r)
             WHERE p.id = ANY (p_products) AND p.status = 'PUBLISHED' AND p.current_version_id IS NOT NULL
             GROUP BY p.id) s), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION core.admin_reviews(p_filter text, p_page int) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := core.admin_actor();
  v_size  int := core.review_limit('review_admin_page_size');
  v_page  int := COALESCE(p_page, 1);
  v_total bigint;
  v_items jsonb;
BEGIN
  IF p_filter IS NULL OR p_filter NOT IN ('ALL', 'HIDDEN') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'filter is ALL or HIDDEN');
  END IF;
  IF v_page < 1 OR v_page > 10000 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'page is a whole number from 1');
  END IF;
  SELECT count(*) INTO v_total FROM core.product_review r
   WHERE r.status = 'PUBLISHED' AND (p_filter = 'ALL' OR r.hidden);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'reviewId', x.id, 'productId', x.product_id,
           'productName', (SELECT v.name FROM core.product p JOIN core.product_version v ON v.id = p.current_version_id
                            WHERE p.id = x.product_id),
           'rating', x.rating, 'title', x.title, 'body', x.body,
           'handle', (SELECT up.handle FROM core.user_profile up WHERE up.id = x.user_id),
           'createdOn', core.review_day(x), 'edited', x.version > 1, 'hidden', x.hidden,
           'hiddenReason', x.hidden_reason, 'public', core.review_is_public(x))
         ORDER BY x.created_at DESC, x.id DESC), '[]'::jsonb)
    INTO v_items
    FROM (SELECT r.* FROM core.product_review r
           WHERE r.status = 'PUBLISHED' AND (p_filter = 'ALL' OR r.hidden)
           ORDER BY r.created_at DESC, r.id DESC OFFSET (v_page - 1) * v_size LIMIT v_size) x;
  RETURN jsonb_build_object('items', v_items, 'page', v_page, 'pageSize', v_size, 'total', v_total,
                            'totalPages', (v_total + v_size - 1) / v_size);
END $$;

-- ---------------------------------------------------------------- privileges
REVOKE ALL ON FUNCTION core.review_limit(text), core.ascii_digits(text), core.has_invisible(text),
  core.review_public_before()
  FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;
