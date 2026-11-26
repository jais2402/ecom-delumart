-- Product ratings and reviews (docs/decisions.md #14). Not in the PRD; decided for the owner.
--
-- Records (owner-only: RLS on with no policy that admits anyone, every privilege revoked from every
-- application role; reached only through the owner-run definer commands below):
--   core.product_review          one row per (player, product), FOREVER: the current rating, title
--                                and body, the version number, the moderation flag. Its id is a
--                                RANDOM uuid (v4), so it says nothing about when it was written.
--                                Deleting a review clears its text and versions and keeps a
--                                tombstone (status DELETED) that remembers a moderator's hide, so
--                                delete-and-write-again cannot undo moderation.
--   core.product_review_version  append-only history of each edit (never updated); a delete
--                                removes them all (the author's text goes for real).
--
-- Rules (REV-1..5; docs/decisions.md #14):
--   * Only a player who OWNS the product (core.ownership, state ACTIVE) may write; never an owner
--     of the selling company (company memberships are not built: the owner is the only member).
--     Nothing else inserts a review: no job, seed or NPC path (a test greps the catalog for it).
--   * One review per player and product: saving again edits it (a new version; "Edited").
--     Saving the same rating, title and body again changes nothing, so a client retry is safe; a
--     repeated delete answers "deleted" again.
--   * Rating 1-5 (required). Title up to `review_title_max_chars` (80), body up to
--     `review_body_max_chars` (1000), configuration; blank text is stored as none. The web server
--     screens the text with packages/core/src/screening first (links, emails, phone- and
--     card-like numbers, abuse; anything not OK is refused with field reasons and never echoed);
--     this database re-checks lengths and control characters and, as a backstop, refuses links,
--     email addresses and digit runs of ten or more (REVIEW_INVALID).
--   * Public (core.product_reviews, core.product_review_summaries; no session needed): a review
--     counts and shows only when it is not deleted or hidden, its author's account is ACTIVE, the
--     ownership is still ACTIVE, the product is PUBLISHED, and the purchase that created the
--     ownership was placed BEFORE core.seller_visible_before() (0060: the start of the current
--     minute), so a review written in the minute of its purchase cannot be matched to the sale
--     more precisely than the seller's own order views allow. The day is shown (in the store's
--     reporting zone, core.company_time_zone), never a time. No user id, order-side id, ownership
--     id, review id or purchase time is returned; the author is their public handle or null
--     ("Verified owner"). Averages are integers: count, sum and averageTenths (43 is 4.3).
--   * Moderation: the Super Admin (core.admin_actor) hides a review with a reason
--     (core.admin_reason: 5-500 characters, no contact details) and restores it; each is one
--     audit-chain row ('review.hide' / 'review.restore', target 'review'). A hidden review leaves
--     the aggregate and the list; its author still sees it, marked hidden, with the reason.
--
-- Locks: a player's review commands take their own profile row (FOR NO KEY UPDATE, as the address
-- book does, 0058) and then their own review row; the Super Admin's take the review row only.
-- Neither takes any lock of the canonical order (LLD §4), so they cannot deadlock with a payment.
--
-- Analytics: review_submitted and review_hidden are added to the server-event allow-list (0052,
-- 0061): no props, no visitor or place key, the hour only, recorded by the web server after the
-- command succeeded, through analytics.record_event.

-- ---------------------------------------------------------------- records
CREATE TABLE core.product_review (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    uuid NOT NULL REFERENCES core.product (id),
  user_id       uuid NOT NULL REFERENCES core.user_profile (id),
  status        text NOT NULL CHECK (status IN ('PUBLISHED', 'DELETED')),
  rating        smallint CHECK (rating BETWEEN 1 AND 5),
  title         text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 200),
  body          text CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 4000),
  version       int NOT NULL CHECK (version >= 0),
  hidden        boolean NOT NULL DEFAULT false,
  hidden_reason text CHECK (hidden_reason IS NULL OR char_length(hidden_reason) <= 500),
  hidden_at     timestamptz,
  created_at    timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, product_id),
  CONSTRAINT product_review_state CHECK (
    (status = 'PUBLISHED' AND rating IS NOT NULL AND version >= 1 AND created_at IS NOT NULL)
    OR (status = 'DELETED' AND rating IS NULL AND title IS NULL AND body IS NULL AND version = 0
        AND created_at IS NULL)),
  CONSTRAINT product_review_hidden CHECK (hidden = (hidden_reason IS NOT NULL) AND hidden = (hidden_at IS NOT NULL))
);
CREATE INDEX product_review_product ON core.product_review (product_id, created_at DESC) WHERE status = 'PUBLISHED';
CREATE INDEX product_review_recent ON core.product_review (created_at DESC) WHERE status = 'PUBLISHED';

CREATE TABLE core.product_review_version (
  review_id  uuid NOT NULL REFERENCES core.product_review (id),
  version    int NOT NULL CHECK (version >= 1),
  rating     smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title      text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 200),
  body       text CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (review_id, version)
);

ALTER TABLE core.product_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.product_review_version ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON core.product_review USING (false) WITH CHECK (false);
CREATE POLICY owner_only ON core.product_review_version USING (false) WITH CHECK (false);
REVOKE ALL ON core.product_review, core.product_review_version
  FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;

-- a version is history: never changed
CREATE TRIGGER no_update BEFORE UPDATE ON core.product_review_version
  FOR EACH ROW EXECUTE FUNCTION core.refuse_change();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON core.product_review_version
  FOR EACH STATEMENT EXECUTE FUNCTION core.refuse_delete();

-- whose review of what never changes, whoever writes
CREATE FUNCTION core.guard_product_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW.id, NEW.product_id, NEW.user_id) IS DISTINCT FROM (OLD.id, OLD.product_id, OLD.user_id) THEN
    RAISE EXCEPTION 'a review''s author and product never change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard BEFORE UPDATE ON core.product_review
  FOR EACH ROW EXECUTE FUNCTION core.guard_product_review();

-- ---------------------------------------------------------------- helpers (owner only)
-- The purchase behind the actor's ownership was placed before the current minute began.
CREATE FUNCTION core.review_purchase_settled(p_user uuid, p_product uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM core.ownership o
      JOIN core.order_line l ON l.id = o.order_line_id
      JOIN core.seller_order so ON so.id = l.seller_order_id
      JOIN core.order_group g ON g.id = so.order_group_id
     WHERE o.user_id = p_user AND o.product_id = p_product AND o.state = 'ACTIVE'
       AND g.created_at < core.seller_visible_before())
$$;

-- Shown publicly and counted (see the header).
CREATE FUNCTION core.review_is_public(r core.product_review) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT r.status = 'PUBLISHED' AND NOT r.hidden
     AND EXISTS (SELECT 1 FROM core.user_profile up WHERE up.id = r.user_id AND up.status = 'ACTIVE')
     AND EXISTS (SELECT 1 FROM core.product p WHERE p.id = r.product_id AND p.status = 'PUBLISHED')
     AND core.review_purchase_settled(r.user_id, r.product_id)
$$;

-- The day a review was written, in the store's reporting zone (never a time).
CREATE FUNCTION core.review_day(r core.product_review) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT to_char((r.created_at AT TIME ZONE core.company_time_zone(
                   (SELECT p.company_id FROM core.product p WHERE p.id = r.product_id)))::date, 'YYYY-MM-DD')
$$;

-- Why the actor may not write a review of the product now, or NULL when they may.
CREATE FUNCTION core.review_ineligibility(p_actor uuid, p_product uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM core.product p
                      WHERE p.id = p_product AND p.status = 'PUBLISHED' AND p.current_version_id IS NOT NULL)
      THEN 'UNAVAILABLE'
    WHEN NOT EXISTS (SELECT 1 FROM core.user_profile up WHERE up.id = p_actor AND up.status = 'ACTIVE')
      THEN 'ACCOUNT'
    WHEN EXISTS (SELECT 1 FROM core.product p JOIN core.company c ON c.id = p.company_id
                  WHERE p.id = p_product AND c.owner_user_id = p_actor)
      THEN 'SELLER'
    WHEN NOT EXISTS (SELECT 1 FROM core.ownership o
                      WHERE o.user_id = p_actor AND o.product_id = p_product AND o.state = 'ACTIVE')
      THEN 'NOT_OWNER'
  END
$$;

-- The signed-in actor, with their profile row locked: one player's review commands serialise.
CREATE FUNCTION core.review_actor() RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := core.actor_id();
BEGIN
  IF v_actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  PERFORM 1 FROM core.user_profile p WHERE p.id = v_actor FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM core.fail('ONBOARDING_REQUIRED', 'finish setting up your account first');
  END IF;
  RETURN v_actor;
END $$;

-- The shape rules (the web server has screened the text already); REVIEW_INVALID.
CREATE FUNCTION core.review_check_input(p_rating int, p_title text, p_body text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_cfg int := core.current_config_id();
  v_text text;
BEGIN
  IF p_rating IS NULL OR p_rating NOT BETWEEN 1 AND 5 THEN
    PERFORM core.fail('REVIEW_INVALID', 'a rating is a whole number from 1 to 5');
  END IF;
  IF p_title IS NOT NULL AND (char_length(p_title) > core.config_int(v_cfg, ARRAY['review_title_max_chars'], 80)
                              OR p_title ~ '[[:cntrl:]]') THEN
    PERFORM core.fail('REVIEW_INVALID', 'a title is at most 80 characters on one line');
  END IF;
  IF p_body IS NOT NULL AND (char_length(p_body) > core.config_int(v_cfg, ARRAY['review_body_max_chars'], 1000)
                             OR replace(p_body, E'\n', '') ~ '[[:cntrl:]]') THEN
    PERFORM core.fail('REVIEW_INVALID', 'a review is at most 1,000 characters');
  END IF;
  v_text := COALESCE(p_title, '') || E'\n' || COALESCE(p_body, '');
  IF v_text ~* '(https?://|www\.)' OR v_text ~ '[^[:space:]@]+@[^[:space:]@]+\.[[:alpha:]]{2,}'
     OR EXISTS (SELECT 1 FROM regexp_matches(v_text, '([0-9][0-9 ().+/-]*)', 'g') m
                 WHERE char_length(regexp_replace(m[1], '[^0-9]', '', 'g')) >= 10) THEN
    PERFORM core.fail('REVIEW_INVALID', 'a review may not contain links, contact details or long numbers');
  END IF;
END $$;

-- The author's own view of their review (they see it hidden, with the reason).
CREATE FUNCTION core.review_own_json(r core.product_review) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('rating', r.rating, 'title', r.title, 'body', r.body, 'createdOn', core.review_day(r),
                            'edited', r.version > 1, 'version', r.version, 'hidden', r.hidden,
                            'hiddenReason', r.hidden_reason, 'public', core.review_is_public(r))
$$;

-- ---------------------------------------------------------------- the author's commands (app_web)
CREATE FUNCTION core.review_save(p_product uuid, p_rating int, p_title text, p_body text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_title   text := NULLIF(btrim(p_title), '');
  v_body    text := NULLIF(btrim(p_body), '');
  v_actor   uuid;
  v_why     text;
  v_r       core.product_review;
  v_changed boolean := true;
BEGIN
  PERFORM core.review_check_input(p_rating, v_title, v_body);
  v_actor := core.review_actor();
  v_why := core.review_ineligibility(v_actor, p_product);
  IF v_why = 'UNAVAILABLE' THEN
    PERFORM core.fail('NOT_FOUND', 'product not found');
  ELSIF v_why IS NOT NULL THEN
    PERFORM core.fail('REVIEW_NOT_ALLOWED', 'only a player who owns this product can review it');
  END IF;

  SELECT * INTO v_r FROM core.product_review r WHERE r.user_id = v_actor AND r.product_id = p_product FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO core.product_review (product_id, user_id, status, rating, title, body, version, created_at, updated_at)
    VALUES (p_product, v_actor, 'PUBLISHED', p_rating, v_title, v_body, 1, clock_timestamp(), clock_timestamp())
    RETURNING * INTO v_r;
  ELSIF v_r.status = 'DELETED' THEN
    UPDATE core.product_review r
       SET status = 'PUBLISHED', rating = p_rating, title = v_title, body = v_body, version = 1,
           created_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE r.id = v_r.id RETURNING * INTO v_r;
  ELSIF (v_r.rating, v_r.title, v_r.body) IS NOT DISTINCT FROM (p_rating::smallint, v_title, v_body) THEN
    v_changed := false;
  ELSE
    UPDATE core.product_review r
       SET rating = p_rating, title = v_title, body = v_body, version = r.version + 1, updated_at = clock_timestamp()
     WHERE r.id = v_r.id RETURNING * INTO v_r;
  END IF;
  IF v_changed THEN
    INSERT INTO core.product_review_version (review_id, version, rating, title, body)
    VALUES (v_r.id, v_r.version, v_r.rating, v_r.title, v_r.body);
  END IF;
  RETURN core.review_own_json(v_r) || jsonb_build_object('productId', p_product, 'changed', v_changed);
END $$;

CREATE FUNCTION core.review_delete(p_product uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_actor uuid;
  v_r     core.product_review;
BEGIN
  v_actor := core.review_actor();
  SELECT * INTO v_r FROM core.product_review r WHERE r.user_id = v_actor AND r.product_id = p_product FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM core.fail('REVIEW_NOT_FOUND', 'review not found');
  END IF;
  IF v_r.status = 'DELETED' THEN
    RETURN jsonb_build_object('productId', p_product, 'deleted', true, 'changed', false);
  END IF;
  DELETE FROM core.product_review_version v WHERE v.review_id = v_r.id;
  UPDATE core.product_review r
     SET status = 'DELETED', rating = NULL, title = NULL, body = NULL, version = 0, created_at = NULL,
         updated_at = clock_timestamp()
   WHERE r.id = v_r.id;
  RETURN jsonb_build_object('productId', p_product, 'deleted', true, 'changed', true);
END $$;

CREATE FUNCTION core.my_review(p_product uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := core.actor_id();
  v_r     core.product_review;
  v_why   text;
BEGIN
  IF v_actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  v_why := core.review_ineligibility(v_actor, p_product);
  SELECT * INTO v_r FROM core.product_review r
   WHERE r.user_id = v_actor AND r.product_id = p_product AND r.status = 'PUBLISHED';
  RETURN jsonb_build_object(
    'productId', p_product,
    'eligible', v_why IS NULL,
    'reason', v_why,
    'handle', (SELECT up.handle FROM core.user_profile up WHERE up.id = v_actor),
    'review', CASE WHEN v_r.id IS NULL THEN NULL ELSE core.review_own_json(v_r) END);
END $$;

-- ---------------------------------------------------------------- public reads (app_web, no session needed)
CREATE FUNCTION core.product_reviews(p_product uuid, p_page int) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_size   int := core.config_int(core.current_config_id(), ARRAY['review_page_size'], 10)::int;
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

CREATE FUNCTION core.product_review_summaries(p_products uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_products IS NULL OR cardinality(p_products)
       > core.config_int(core.current_config_id(), ARRAY['review_summary_max'], 100) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'too many products');
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'productId', s.id, 'count', s.n, 'ratingSum', s.total,
             'averageTenths', CASE WHEN s.n = 0 THEN 0 ELSE (20 * s.total + s.n) / (2 * s.n) END)
           ORDER BY s.id)
      FROM (SELECT p.id,
                   count(r.id) AS n,
                   COALESCE(sum(r.rating), 0) AS total
              FROM core.product p
              LEFT JOIN core.product_review r
                ON r.product_id = p.id AND r.status = 'PUBLISHED' AND core.review_is_public(r)
             WHERE p.id = ANY (p_products) AND p.status = 'PUBLISHED' AND p.current_version_id IS NOT NULL
             GROUP BY p.id) s), '[]'::jsonb);
END $$;

-- ---------------------------------------------------------------- the Super Admin (app_web)
CREATE FUNCTION core.admin_reviews(p_filter text, p_page int) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := core.admin_actor();
  v_size  int := core.config_int(core.current_config_id(), ARRAY['review_admin_page_size'], 20)::int;
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

CREATE FUNCTION core.admin_review_hide(p_review uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_actor  uuid := core.admin_actor();
  v_reason text := core.admin_reason(p_reason);
  v_r      core.product_review;
BEGIN
  SELECT * INTO v_r FROM core.product_review r WHERE r.id = p_review FOR UPDATE;
  IF NOT FOUND OR v_r.status <> 'PUBLISHED' THEN
    PERFORM core.fail('REVIEW_NOT_FOUND', 'review not found');
  END IF;
  IF v_r.hidden THEN
    PERFORM core.fail('CONFLICT', 'this review is already hidden');
  END IF;
  UPDATE core.product_review r SET hidden = true, hidden_reason = v_reason, hidden_at = clock_timestamp()
   WHERE r.id = v_r.id;
  PERFORM core.admin_audit(v_actor, 'review.hide', 'review', v_r.id::text, v_reason,
                           jsonb_build_object('productId', v_r.product_id));
  RETURN jsonb_build_object('reviewId', v_r.id, 'hidden', true);
END $$;

CREATE FUNCTION core.admin_review_restore(p_review uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_actor  uuid := core.admin_actor();
  v_reason text := core.admin_reason(p_reason);
  v_r      core.product_review;
BEGIN
  SELECT * INTO v_r FROM core.product_review r WHERE r.id = p_review FOR UPDATE;
  IF NOT FOUND OR v_r.status <> 'PUBLISHED' THEN
    PERFORM core.fail('REVIEW_NOT_FOUND', 'review not found');
  END IF;
  IF NOT v_r.hidden THEN
    PERFORM core.fail('CONFLICT', 'this review is not hidden');
  END IF;
  UPDATE core.product_review r SET hidden = false, hidden_reason = NULL, hidden_at = NULL WHERE r.id = v_r.id;
  PERFORM core.admin_audit(v_actor, 'review.restore', 'review', v_r.id::text, v_reason,
                           jsonb_build_object('productId', v_r.product_id));
  RETURN jsonb_build_object('reviewId', v_r.id, 'hidden', false);
END $$;

-- ---------------------------------------------------------------- analytics allow-lists (0052, 0061)
CREATE OR REPLACE FUNCTION analytics.event_names() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['page_view', 'search', 'product_view', 'cart_add', 'checkout_start',
               'purchase', 'sign_up', 'creator_unlock', 'shop_registered', 'listing_published',
               'review_submitted', 'review_hidden']
$$;

CREATE OR REPLACE FUNCTION analytics.server_event_names() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['purchase', 'sign_up', 'creator_unlock', 'shop_registered', 'listing_published',
               'review_submitted', 'review_hidden']
$$;

-- ---------------------------------------------------------------- privileges
REVOKE ALL ON FUNCTION core.guard_product_review(), core.review_purchase_settled(uuid, uuid),
  core.review_is_public(core.product_review), core.review_day(core.product_review),
  core.review_ineligibility(uuid, uuid), core.review_actor(), core.review_check_input(int, text, text),
  core.review_own_json(core.product_review), core.review_save(uuid, int, text, text), core.review_delete(uuid),
  core.my_review(uuid), core.product_reviews(uuid, int), core.product_review_summaries(uuid[]),
  core.admin_reviews(text, int), core.admin_review_hide(uuid, text), core.admin_review_restore(uuid, text)
  FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;
GRANT EXECUTE ON FUNCTION core.review_save(uuid, int, text, text), core.review_delete(uuid), core.my_review(uuid),
  core.product_reviews(uuid, int), core.product_review_summaries(uuid[]), core.admin_reviews(text, int),
  core.admin_review_hide(uuid, text), core.admin_review_restore(uuid, text)
  TO app_web;
