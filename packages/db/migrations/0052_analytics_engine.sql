-- The analytics engine (PRD R7.1, R15.2, R16.5; architecture §9.6, §18.2): privacy-safe event
-- capture, usage by place, daily rollups with small-count suppression, and the Super Admin's reads.
--
--  * analytics.event replaces the unused table of 0009 (it had a session id and a direct INSERT
--    grant to app_web). The new table holds NO user id, session id, address, user agent, email,
--    phone, search text or exact amount: a minute-truncated time, the UTC day, an allow-listed
--    name, the surface, a 16-byte daily-rotating visitor key (computed by the web server from a
--    secret it holds; the address and user agent never reach the database), whether the request
--    was signed in, the edge's approximate place (country, region, city), the device class and a
--    small props object restricted per event name (analytics.props_valid). Append-only: no UPDATE,
--    no TRUNCATE; DELETE only through the retention purge.
--  * Writes go through analytics.record_event (app_web) only, as the caller's session: a signed-in
--    account that has switched on the research opt-out (core.user_profile.research_opt_out, R15.2)
--    or is a test account (STAFF source, R16.8) records nothing. Server events (purchase, sign_up,
--    creator_unlock, shop_registered) need a signed-in actor; a shop_registered company must be the
--    actor's. product_view and cart_add name a published product: the database derives its
--    category and company itself and ignores anything else. listing_published is written only by a
--    trigger when a user's listing is first published, whatever path published it (screening job,
--    Super Admin approval, allocate-and-publish); an analytics failure never blocks publication.
--    Likewise a creator unlock by the passport (ACHIEVEMENT) is written by a trigger on
--    core.creator_entitlement; an unlock by spending is recorded by the web server with the purchase.
--  * analytics.rollup_day(date) (owner only; the jobs call core.analytics_rollup_job()) replaces a
--    day's rows of analytics.daily_rollup: idempotent. Place rows are suppressed before they are
--    stored: a city with fewer than `analytics.place_min_visitors` (10, PRD R7.1) distinct visitors
--    that day becomes 'Other' in its region, a region below it 'Other' in its country, a country
--    below it 'Other'. Raw events are purged after `analytics.raw_retention_days` (90); rollups stay.
--  * Authoritative figures (orders, ledger spend, sign-ups, creator unlocks, shops, listings) are
--    read from the real tables, never from events (invariant 5). Every admin read checks the Super
--    Admin itself (core.admin_actor(): FORBIDDEN before anything is read) and returns aggregates.
--  * analytics.dev_seed_synthetic_events(int) is owner-only: local synthetic data for the console.
--  * No application role holds any privilege on the new tables; RLS is on with an owner-only policy.

-- ---------------------------------------------------------------- the old table goes
DROP TABLE analytics.event CASCADE;

-- ---------------------------------------------------------------- allow-lists
CREATE FUNCTION analytics.event_names() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['page_view', 'search', 'product_view', 'cart_add', 'checkout_start',
               'purchase', 'sign_up', 'creator_unlock', 'shop_registered', 'listing_published']
$$;

-- A region or city label: 1-64 characters, trimmed, with no control or invisible formatting
-- character, no separator ('|' joins place parts in the rollup) and no markup or quoting character.
-- (The web server is stricter still: @delulu/core parsePlace.)
CREATE FUNCTION analytics.label_ok(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p IS NOT NULL AND char_length(p) BETWEEN 1 AND 64 AND p = btrim(p)
         AND p !~ '[[:cntrl:]|<>"\\=;`{}]'
         AND p !~ '[\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]'
$$;

-- The props an event may carry: per name, only the listed keys, each with a bounded value.
CREATE FUNCTION analytics.props_valid(p_name text, p_props jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_props IS NOT NULL AND jsonb_typeof(p_props) = 'object' AND octet_length(p_props::text) <= 256
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_each(p_props) e
        WHERE e.key <> ALL (CASE p_name
                WHEN 'search'            THEN ARRAY['result_count_bucket', 'query_length_bucket', 'category']
                WHEN 'product_view'      THEN ARRAY['product_id', 'category', 'company_id']
                WHEN 'cart_add'          THEN ARRAY['product_id', 'category', 'company_id']
                WHEN 'listing_published' THEN ARRAY['product_id', 'category', 'company_id']
                WHEN 'checkout_start'    THEN ARRAY['item_count', 'amount_bucket']
                WHEN 'purchase'          THEN ARRAY['item_count', 'amount_bucket']
                WHEN 'shop_registered'   THEN ARRAY['company_id']
                ELSE ARRAY[]::text[] END)
           OR NOT CASE e.key
                WHEN 'product_id' THEN jsonb_typeof(e.value) = 'string'
                  AND (e.value #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                WHEN 'company_id' THEN jsonb_typeof(e.value) = 'string'
                  AND (e.value #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                WHEN 'category' THEN jsonb_typeof(e.value) = 'string' AND (e.value #>> '{}') ~ '^[a-z0-9-]{1,40}$'
                WHEN 'result_count_bucket' THEN jsonb_typeof(e.value) = 'string'
                  AND (e.value #>> '{}') IN ('0', '1-5', '6-20', '21+')
                WHEN 'query_length_bucket' THEN jsonb_typeof(e.value) = 'string'
                  AND (e.value #>> '{}') IN ('0', '1-3', '4-10', '11-30', '31+')
                WHEN 'amount_bucket' THEN jsonb_typeof(e.value) = 'string'
                  AND (e.value #>> '{}') IN ('lt_1k', '1k_10k', '10k_1l', '1l_10l', '10l_1cr', '1cr_plus')
                WHEN 'item_count' THEN jsonb_typeof(e.value) = 'number'
                  AND (e.value #>> '{}') ~ '^[0-9]{1,3}$' AND (e.value #>> '{}')::int BETWEEN 1 AND 100
                ELSE false END)
$$;

-- ---------------------------------------------------------------- tables
CREATE TABLE analytics.event (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at  timestamptz NOT NULL CHECK (mod(extract(epoch FROM occurred_at), 60) = 0),
  day          date NOT NULL,
  name         text NOT NULL CHECK (name = ANY (analytics.event_names())),
  surface      text NOT NULL CHECK (surface IN ('shop', 'account', 'checkout', 'studio', 'console')),
  -- null only for the events the database records itself (no visitor's request carries them)
  visitor_key  bytea CHECK (octet_length(visitor_key) = 16),
  signed_in    boolean NOT NULL,
  country      text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  region       text CHECK (region IS NULL OR analytics.label_ok(region)),
  city         text CHECK (city IS NULL OR analytics.label_ok(city)),
  device_class text NOT NULL CHECK (device_class IN ('mobile', 'tablet', 'desktop', 'unknown')),
  props        jsonb NOT NULL DEFAULT '{}' CHECK (analytics.props_valid(name, props)),
  CONSTRAINT event_day_of_time CHECK (day = (occurred_at AT TIME ZONE 'UTC')::date),
  CONSTRAINT event_visitor_known CHECK (visitor_key IS NOT NULL OR name IN ('listing_published', 'creator_unlock')),
  CONSTRAINT event_unknown_country_has_no_place CHECK (country <> 'ZZ' OR (region IS NULL AND city IS NULL))
);
CREATE INDEX event_day ON analytics.event (day);

CREATE TABLE analytics.daily_rollup (
  day             date NOT NULL,
  metric          text NOT NULL CHECK (metric IN ('visitors', 'page_views', 'searches', 'sign_ups', 'product_views',
                    'cart_adds', 'checkout_starts', 'purchases', 'creator_unlocks', 'shops_registered',
                    'listings_published')),
  dimension_kind  text NOT NULL CHECK (dimension_kind IN ('none', 'country', 'region', 'city', 'surface',
                    'device_class', 'category', 'product', 'company')),
  dimension_value text NOT NULL CHECK (char_length(dimension_value) <= 200),
  count           bigint NOT NULL CHECK (count >= 0),
  visitors        bigint NOT NULL CHECK (visitors >= 0),
  computed_at     timestamptz NOT NULL,
  PRIMARY KEY (day, metric, dimension_kind, dimension_value)
);

-- one row per rolled-up day: coverage ("unavailable, never zero") and the lock of a rerun
CREATE TABLE analytics.rollup_run (
  day          date PRIMARY KEY,
  computed_at  timestamptz NOT NULL,
  events       bigint NOT NULL CHECK (events >= 0),
  min_visitors int NOT NULL CHECK (min_visitors >= 1)
);

ALTER TABLE analytics.event ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_rollup ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.rollup_run ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON analytics.event USING (false) WITH CHECK (false);
CREATE POLICY owner_only ON analytics.daily_rollup USING (false) WITH CHECK (false);
CREATE POLICY owner_only ON analytics.rollup_run USING (false) WITH CHECK (false);
REVOKE ALL ON analytics.event, analytics.daily_rollup, analytics.rollup_run
  FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;
REVOKE ALL ON SEQUENCE analytics.event_id_seq
  FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;

-- ---------------------------------------------------------------- append-only
CREATE FUNCTION analytics.guard_event() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('analytics.purging', true) = 'on' THEN
    RETURN OLD;
  END IF;
  PERFORM core.fail('FORBIDDEN', 'analytics events are append-only; only the retention purge deletes them');
  RETURN NULL;
END $$;
CREATE TRIGGER event_append_only BEFORE UPDATE OR DELETE ON analytics.event
  FOR EACH ROW EXECUTE FUNCTION analytics.guard_event();
CREATE TRIGGER event_no_truncate BEFORE TRUNCATE ON analytics.event
  FOR EACH STATEMENT EXECUTE FUNCTION analytics.guard_event();

-- ---------------------------------------------------------------- configuration
CREATE FUNCTION analytics.raw_retention_days() RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT GREATEST(core.config_int(core.current_config_id(), ARRAY['analytics', 'raw_retention_days'], 90), 2)::int
$$;

CREATE FUNCTION analytics.place_min_visitors() RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT GREATEST(core.config_int(core.current_config_id(), ARRAY['analytics', 'place_min_visitors'], 10), 1)::int
$$;

CREATE FUNCTION analytics.max_range_days() RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT GREATEST(core.config_int(core.current_config_id(), ARRAY['analytics', 'max_range_days'], 366), 1)::int
$$;

CREATE FUNCTION analytics.utc_today() RETURNS date
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date
$$;

-- ---------------------------------------------------------------- capture
CREATE FUNCTION analytics.record_event(p_name text, p_surface text, p_visitor_key bytea, p_country text,
                                       p_region text, p_city text, p_device_class text, p_props jsonb)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_actor   uuid := core.actor_id();
  v_now     timestamptz := date_trunc('minute', clock_timestamp());
  v_props   jsonb := COALESCE(p_props, '{}'::jsonb);
  v_product record;
BEGIN
  IF p_name IS NULL OR p_name <> ALL (analytics.event_names()) OR p_name = 'listing_published' THEN
    PERFORM core.fail('VALIDATION_FAILED', 'unknown event name');
  END IF;
  IF p_name IN ('purchase', 'sign_up', 'creator_unlock', 'shop_registered') AND v_actor IS NULL THEN
    PERFORM core.fail('VALIDATION_FAILED', 'a server event needs a signed-in actor');
  END IF;
  IF p_surface IS NULL OR p_surface NOT IN ('shop', 'account', 'checkout', 'studio', 'console') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'unknown surface');
  END IF;
  IF p_visitor_key IS NULL OR octet_length(p_visitor_key) <> 16 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'the visitor key is 16 bytes');
  END IF;
  IF p_country IS NULL OR p_country !~ '^[A-Z]{2}$'
     OR (p_region IS NOT NULL AND NOT analytics.label_ok(p_region))
     OR (p_city IS NOT NULL AND NOT analytics.label_ok(p_city))
     OR (p_country = 'ZZ' AND (p_region IS NOT NULL OR p_city IS NOT NULL)) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'the place is not valid');
  END IF;
  IF p_device_class IS NULL OR p_device_class NOT IN ('mobile', 'tablet', 'desktop', 'unknown') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'unknown device class');
  END IF;
  IF NOT analytics.props_valid(p_name, v_props) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'the props are not allowed for this event');
  END IF;

  -- research opt-out (R15.2) and test accounts (R16.8): nothing is recorded
  IF v_actor IS NOT NULL AND EXISTS (SELECT 1 FROM core.user_profile up
                                      WHERE up.id = v_actor AND (up.research_opt_out OR up.is_test_account)) THEN
    RETURN false;
  END IF;

  IF p_name IN ('product_view', 'cart_add') THEN
    -- the product's category and company come from the catalog, never from the caller
    IF NOT v_props ? 'product_id' THEN
      PERFORM core.fail('VALIDATION_FAILED', 'this event names a product');
    END IF;
    SELECT p.id, p.category, p.company_id INTO v_product
      FROM core.product p WHERE p.id = (v_props ->> 'product_id')::uuid AND p.status = 'PUBLISHED';
    IF NOT FOUND THEN
      RETURN false;
    END IF;
    v_props := jsonb_strip_nulls(jsonb_build_object('product_id', v_product.id, 'company_id', v_product.company_id))
               || CASE WHEN v_product.category ~ '^[a-z0-9-]{1,40}$'
                       THEN jsonb_build_object('category', v_product.category) ELSE '{}'::jsonb END;
  ELSIF p_name = 'shop_registered' THEN
    IF NOT EXISTS (SELECT 1 FROM core.company c
                    WHERE c.id = (v_props ->> 'company_id')::uuid AND c.owner_user_id = v_actor) THEN
      PERFORM core.fail('VALIDATION_FAILED', 'the company is not the actor''s');
    END IF;
  END IF;

  INSERT INTO analytics.event (occurred_at, day, name, surface, visitor_key, signed_in, country, region, city,
                               device_class, props)
  VALUES (v_now, (v_now AT TIME ZONE 'UTC')::date, p_name, p_surface, p_visitor_key, v_actor IS NOT NULL,
          p_country, p_region, p_city, p_device_class, v_props);
  RETURN true;
END $$;

-- A user's listing published for the first time (any path). Never blocks the publication.
CREATE FUNCTION analytics.on_listing_published() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_now timestamptz := date_trunc('minute', clock_timestamp());
BEGIN
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM core.company c JOIN core.user_profile up ON up.id = c.owner_user_id
                    WHERE c.id = NEW.company_id AND (up.research_opt_out OR up.is_test_account)) THEN
      INSERT INTO analytics.event (occurred_at, day, name, surface, visitor_key, signed_in, country, region, city,
                                   device_class, props)
      VALUES (v_now, (v_now AT TIME ZONE 'UTC')::date, 'listing_published', 'studio', NULL, true, 'ZZ', NULL, NULL,
              'unknown',
              jsonb_build_object('product_id', NEW.id, 'company_id', NEW.company_id)
              || CASE WHEN NEW.category ~ '^[a-z0-9-]{1,40}$'
                      THEN jsonb_build_object('category', NEW.category) ELSE '{}'::jsonb END);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL; -- analytics never blocks publication
  END;
  RETURN NULL;
END $$;
CREATE TRIGGER analytics_listing_published AFTER UPDATE OF published_at ON core.product
  FOR EACH ROW WHEN (OLD.published_at IS NULL AND NEW.published_at IS NOT NULL AND NEW.seller_type = 'USER')
  EXECUTE FUNCTION analytics.on_listing_published();

-- A creator unlock by the passport (ACHIEVEMENT), whichever command completed it. (An unlock by
-- spending is recorded by the web server with the purchase, which knows the request's place.)
CREATE FUNCTION analytics.on_creator_unlocked() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_now timestamptz := date_trunc('minute', clock_timestamp());
BEGIN
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM core.user_profile up
                    WHERE up.id = NEW.user_id AND (up.research_opt_out OR up.is_test_account)) THEN
      INSERT INTO analytics.event (occurred_at, day, name, surface, visitor_key, signed_in, country, region, city,
                                   device_class, props)
      VALUES (v_now, (v_now AT TIME ZONE 'UTC')::date, 'creator_unlock', 'account', NULL, true, 'ZZ', NULL, NULL,
              'unknown', '{}'::jsonb);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL; -- analytics never blocks the unlock
  END;
  RETURN NULL;
END $$;
CREATE TRIGGER analytics_creator_unlocked AFTER INSERT ON core.creator_entitlement
  FOR EACH ROW WHEN (NEW.source = 'ACHIEVEMENT')
  EXECUTE FUNCTION analytics.on_creator_unlocked();

-- ---------------------------------------------------------------- rollup
CREATE FUNCTION analytics.rollup_day(p_day date) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '5s' AS $$
DECLARE
  v_today  date := analytics.utc_today();
  v_k      int := analytics.place_min_visitors();
  v_now    timestamptz := clock_timestamp();
  v_events bigint;
  v_rows   bigint;
BEGIN
  IF p_day IS NULL OR p_day > v_today THEN
    PERFORM core.fail('VALIDATION_FAILED', 'a day up to today');
  END IF;
  IF p_day < v_today - analytics.raw_retention_days() THEN
    PERFORM core.fail('VALIDATION_FAILED', 'the raw events of that day are past retention; its rollup is kept');
  END IF;
  SELECT count(*) INTO v_events FROM analytics.event e WHERE e.day = p_day;
  -- the run row is the lock: concurrent rollups of one day take turns
  INSERT INTO analytics.rollup_run AS rr (day, computed_at, events, min_visitors)
  VALUES (p_day, v_now, v_events, v_k)
  ON CONFLICT (day) DO UPDATE SET computed_at = EXCLUDED.computed_at, events = EXCLUDED.events,
                                  min_visitors = EXCLUDED.min_visitors;
  DELETE FROM analytics.daily_rollup r WHERE r.day = p_day;

  WITH ev AS (
    SELECT e.name, e.surface, e.device_class, e.visitor_key, e.props,
           e.country AS c, COALESCE(e.region, '') AS r, COALESCE(e.city, '') AS t
      FROM analytics.event e WHERE e.day = p_day
  ),
  cv AS (SELECT ev.c, count(DISTINCT ev.visitor_key) AS v FROM ev GROUP BY ev.c),
  rv AS (SELECT ev.c, ev.r, count(DISTINCT ev.visitor_key) AS v FROM ev GROUP BY ev.c, ev.r),
  tv AS (SELECT ev.c, ev.r, ev.t, count(DISTINCT ev.visitor_key) AS v FROM ev GROUP BY ev.c, ev.r, ev.t),
  -- small-count suppression: city -> region -> country -> 'Other', before anything is stored
  placed AS (
    SELECT ev.*,
           CASE WHEN cv.v >= v_k THEN ev.c ELSE 'Other' END AS c1,
           CASE WHEN cv.v >= v_k AND rv.v >= v_k THEN ev.r ELSE 'Other' END AS r1,
           CASE WHEN cv.v >= v_k AND rv.v >= v_k AND tv.v >= v_k THEN ev.t ELSE 'Other' END AS t1
      FROM ev
      JOIN cv ON cv.c = ev.c
      JOIN rv ON rv.c = ev.c AND rv.r = ev.r
      JOIN tv ON tv.c = ev.c AND tv.r = ev.r AND tv.t = ev.t
  ),
  metric AS (
    SELECT p.*, m.metric
      FROM placed p
     CROSS JOIN LATERAL (VALUES
       (CASE p.name WHEN 'page_view' THEN 'page_views' WHEN 'search' THEN 'searches'
                    WHEN 'product_view' THEN 'product_views' WHEN 'cart_add' THEN 'cart_adds'
                    WHEN 'checkout_start' THEN 'checkout_starts' WHEN 'purchase' THEN 'purchases'
                    WHEN 'sign_up' THEN 'sign_ups' WHEN 'creator_unlock' THEN 'creator_unlocks'
                    WHEN 'shop_registered' THEN 'shops_registered' WHEN 'listing_published' THEN 'listings_published'
        END),
       (CASE WHEN p.visitor_key IS NOT NULL THEN 'visitors' END)) m(metric)
     WHERE m.metric IS NOT NULL
  ),
  dim AS (
    SELECT m.metric, d.kind, d.value, m.visitor_key
      FROM metric m
     CROSS JOIN LATERAL (VALUES
       ('none', ''),
       ('country', CASE WHEN m.visitor_key IS NOT NULL THEN m.c1 END),
       ('region', CASE WHEN m.visitor_key IS NOT NULL THEN m.c1 || '|' || m.r1 END),
       ('city', CASE WHEN m.visitor_key IS NOT NULL THEN m.c1 || '|' || m.r1 || '|' || m.t1 END),
       ('surface', m.surface),
       ('device_class', m.device_class),
       ('category', CASE WHEN m.metric <> 'visitors' THEN m.props ->> 'category' END),
       ('product', CASE WHEN m.metric <> 'visitors' THEN m.props ->> 'product_id' END),
       ('company', CASE WHEN m.metric <> 'visitors' THEN m.props ->> 'company_id' END)) d(kind, value)
     WHERE d.value IS NOT NULL
  )
  INSERT INTO analytics.daily_rollup (day, metric, dimension_kind, dimension_value, count, visitors, computed_at)
  SELECT p_day, dim.metric, dim.kind, dim.value,
         CASE WHEN dim.metric = 'visitors' THEN count(DISTINCT dim.visitor_key) ELSE count(*) END,
         count(DISTINCT dim.visitor_key), v_now
    FROM dim
   GROUP BY dim.metric, dim.kind, dim.value;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('day', p_day, 'events', v_events, 'rows', v_rows, 'minVisitors', v_k);
END $$;

-- Deletes raw events past retention (rollups are kept); returns how many went.
CREATE FUNCTION analytics.purge_events() RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '5s' AS $$
DECLARE
  n bigint;
BEGIN
  PERFORM set_config('analytics.purging', 'on', true);
  DELETE FROM analytics.event e WHERE e.day < analytics.utc_today() - analytics.raw_retention_days();
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('analytics.purging', 'off', true);
  RETURN n;
END $$;

-- ---------------------------------------------------------------- the jobs (app_jobs)
-- In schema core, like the other jobs functions: app_jobs holds no USAGE on analytics (0047).
CREATE FUNCTION core.analytics_rollup_job() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_today date := analytics.utc_today();
BEGIN
  RETURN jsonb_build_object('yesterday', analytics.rollup_day(v_today - 1), 'today', analytics.rollup_day(v_today));
END $$;

CREATE FUNCTION core.analytics_purge_job() RETURNS bigint
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT analytics.purge_events()
$$;

-- ---------------------------------------------------------------- reads (Super Admin only)
-- Days in [p_from, p_to]; VALIDATION_FAILED for a missing, reversed or too long range.
CREATE FUNCTION analytics.range_days(p_from date, p_to date) RETURNS int
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    PERFORM core.fail('VALIDATION_FAILED', 'from is on or before to');
  END IF;
  IF p_to - p_from + 1 > analytics.max_range_days() THEN
    PERFORM core.fail('VALIDATION_FAILED', format('a range is at most %s days', analytics.max_range_days()));
  END IF;
  RETURN p_to - p_from + 1;
END $$;

CREATE FUNCTION analytics.utc_start(p_day date) RETURNS timestamptz
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_day::timestamp AT TIME ZONE 'UTC'
$$;

-- Totals of [p_from, p_to] from the real tables (players only; test accounts excluded) and the
-- traffic rollups. Internal: called by the admin reads after their check.
CREATE FUNCTION analytics.period_totals(p_from date, p_to date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH b AS (SELECT analytics.utc_start(p_from) AS lo, analytics.utc_start(p_to + 1) AS hi),
  orders AS (
    SELECT g.id, g.journal_id, g.buyer_user_id FROM core.order_group g, b
     WHERE g.buyer_source = 'PLAYER' AND g.created_at >= b.lo AND g.created_at < b.hi
  ),
  -- what buyers paid, from the ledger: the buyer's postings of the purchase journals
  spend AS (
    SELECT COALESCE(sum(-p.amount), 0)::bigint AS paise
      FROM orders o
      JOIN ledger.journal j ON j.id = o.journal_id AND j.event_type = 'PURCHASE'
      JOIN ledger.ledger_account a ON a.user_id = o.buyer_user_id
      JOIN ledger.posting p ON p.journal_id = j.id AND p.account_id = a.id
  ),
  n AS (SELECT count(*) AS orders FROM orders)
  SELECT jsonb_build_object(
    'visitors', (SELECT COALESCE(sum(r.count), 0) FROM analytics.daily_rollup r
                  WHERE r.metric = 'visitors' AND r.dimension_kind = 'none' AND r.day BETWEEN p_from AND p_to),
    'trafficDays', (SELECT count(*) FROM analytics.rollup_run rr WHERE rr.day BETWEEN p_from AND p_to),
    'signUps', (SELECT count(*) FROM core.user_profile up, b
                 WHERE up.provisioned_at >= b.lo AND up.provisioned_at < b.hi
                   AND up.role = 'PLAYER' AND NOT up.is_test_account),
    'orders', n.orders,
    'spendPaise', spend.paise::text,
    'averageOrderValuePaise', CASE WHEN n.orders > 0 THEN (spend.paise / n.orders)::text END,
    'creatorUnlocks', (SELECT count(*) FROM core.creator_entitlement ce
                         JOIN core.user_profile up ON up.id = ce.user_id, b
                        WHERE ce.unlocked_at >= b.lo AND ce.unlocked_at < b.hi AND NOT up.is_test_account),
    'shopsRegistered', (SELECT count(*) FROM core.company c JOIN core.user_profile up ON up.id = c.owner_user_id, b
                         WHERE c.created_at >= b.lo AND c.created_at < b.hi AND NOT up.is_test_account),
    'listingsPublished', (SELECT count(*) FROM core.product p
                            JOIN core.company c ON c.id = p.company_id
                            JOIN core.user_profile up ON up.id = c.owner_user_id, b
                           WHERE p.seller_type = 'USER' AND p.published_at >= b.lo AND p.published_at < b.hi
                             AND NOT up.is_test_account))
  FROM n, spend
$$;

CREATE FUNCTION analytics.admin_overview(p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := core.admin_actor();   -- FORBIDDEN for anyone else, before anything is read
  v_days  int := analytics.range_days(p_from, p_to);
BEGIN
  RETURN jsonb_build_object(
    'from', p_from, 'to', p_to, 'days', v_days,
    'previousFrom', p_from - v_days, 'previousTo', p_from - 1,
    'current', analytics.period_totals(p_from, p_to),
    'previous', analytics.period_totals(p_from - v_days, p_from - 1),
    'asOf', clock_timestamp(),
    'trafficComputedAt', (SELECT max(rr.computed_at) FROM analytics.rollup_run rr
                           WHERE rr.day BETWEEN p_from AND p_to));
END $$;

CREATE FUNCTION analytics.admin_timeseries(p_metric text, p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor  uuid := core.admin_actor();
  v_days   int := analytics.range_days(p_from, p_to);
  v_events text := CASE p_metric WHEN 'visitors' THEN 'visitors' WHEN 'page_views' THEN 'page_views'
                     WHEN 'searches' THEN 'searches' WHEN 'product_views' THEN 'product_views'
                     WHEN 'cart_adds' THEN 'cart_adds' WHEN 'checkout_starts' THEN 'checkout_starts' END;
  v_points jsonb;
BEGIN
  IF v_events IS NULL AND (p_metric IS NULL OR p_metric NOT IN
       ('sign_ups', 'orders', 'spend', 'creator_unlocks', 'shops_registered', 'listings_published')) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'unknown metric');
  END IF;
  IF v_events IS NOT NULL THEN
    -- traffic from the rollups: a day that was never rolled up is unavailable (null), not zero
    SELECT jsonb_agg(jsonb_build_object('day', d.day,
             'value', CASE WHEN rr.day IS NULL THEN NULL ELSE COALESCE(r.count, 0)::text END) ORDER BY d.day)
      INTO v_points
      FROM (SELECT g::date AS day FROM generate_series(p_from, p_to, interval '1 day') g) d
      LEFT JOIN analytics.rollup_run rr ON rr.day = d.day
      LEFT JOIN analytics.daily_rollup r ON r.day = d.day AND r.metric = v_events
                                        AND r.dimension_kind = 'none' AND r.dimension_value = '';
  ELSE
    -- authoritative series from the real tables, one UTC day each
    SELECT jsonb_agg(jsonb_build_object('day', d.day, 'value', (
             SELECT CASE p_metric
               WHEN 'sign_ups' THEN (SELECT count(*) FROM core.user_profile up
                                      WHERE up.provisioned_at >= analytics.utc_start(d.day)
                                        AND up.provisioned_at < analytics.utc_start(d.day + 1)
                                        AND up.role = 'PLAYER' AND NOT up.is_test_account)::text
               WHEN 'orders' THEN (SELECT count(*) FROM core.order_group g
                                    WHERE g.buyer_source = 'PLAYER' AND g.created_at >= analytics.utc_start(d.day)
                                      AND g.created_at < analytics.utc_start(d.day + 1))::text
               WHEN 'spend' THEN (SELECT COALESCE(sum(-p.amount), 0) FROM core.order_group g
                                    JOIN ledger.journal j ON j.id = g.journal_id AND j.event_type = 'PURCHASE'
                                    JOIN ledger.ledger_account a ON a.user_id = g.buyer_user_id
                                    JOIN ledger.posting p ON p.journal_id = j.id AND p.account_id = a.id
                                   WHERE g.buyer_source = 'PLAYER' AND g.created_at >= analytics.utc_start(d.day)
                                     AND g.created_at < analytics.utc_start(d.day + 1))::text
               WHEN 'creator_unlocks' THEN (SELECT count(*) FROM core.creator_entitlement ce
                                             JOIN core.user_profile up ON up.id = ce.user_id
                                            WHERE ce.unlocked_at >= analytics.utc_start(d.day)
                                              AND ce.unlocked_at < analytics.utc_start(d.day + 1)
                                              AND NOT up.is_test_account)::text
               WHEN 'shops_registered' THEN (SELECT count(*) FROM core.company c
                                              JOIN core.user_profile up ON up.id = c.owner_user_id
                                             WHERE c.created_at >= analytics.utc_start(d.day)
                                               AND c.created_at < analytics.utc_start(d.day + 1)
                                               AND NOT up.is_test_account)::text
               WHEN 'listings_published' THEN (SELECT count(*) FROM core.product p
                                                 JOIN core.company c ON c.id = p.company_id
                                                 JOIN core.user_profile up ON up.id = c.owner_user_id
                                                WHERE p.seller_type = 'USER'
                                                  AND p.published_at >= analytics.utc_start(d.day)
                                                  AND p.published_at < analytics.utc_start(d.day + 1)
                                                  AND NOT up.is_test_account)::text
             END)) ORDER BY d.day)
      INTO v_points
      FROM (SELECT g::date AS day FROM generate_series(p_from, p_to, interval '1 day') g) d;
  END IF;
  RETURN jsonb_build_object(
    'metric', p_metric, 'from', p_from, 'to', p_to, 'days', v_days,
    'unit', CASE WHEN p_metric = 'spend' THEN 'paise' ELSE 'count' END,
    'source', CASE WHEN v_events IS NULL THEN 'records' ELSE 'events' END,
    'points', COALESCE(v_points, '[]'::jsonb), 'asOf', clock_timestamp());
END $$;

CREATE FUNCTION analytics.admin_funnel(p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := core.admin_actor();
  v_days  int := analytics.range_days(p_from, p_to);
  v_steps jsonb;
BEGIN
  WITH s AS (
    SELECT st.ord, st.step,
           (SELECT COALESCE(sum(r.visitors), 0) FROM analytics.daily_rollup r
             WHERE r.metric = st.step AND r.dimension_kind = 'none' AND r.day BETWEEN p_from AND p_to) AS visitors
      FROM (VALUES (1, 'visitors'), (2, 'product_views'), (3, 'cart_adds'), (4, 'checkout_starts'),
                   (5, 'purchases')) st(ord, step)
  ),
  w AS (SELECT s.*, lag(s.visitors) OVER (ORDER BY s.ord) AS prev FROM s)
  SELECT jsonb_agg(jsonb_build_object('step', w.step, 'visitors', w.visitors,
           'conversionFromPrevious', CASE WHEN w.prev IS NULL OR w.prev = 0 THEN NULL
                                          ELSE round(w.visitors::numeric / w.prev, 4) END) ORDER BY w.ord)
    INTO v_steps FROM w;
  RETURN jsonb_build_object(
    'from', p_from, 'to', p_to, 'days', v_days, 'steps', v_steps,
    'overallConversion', (SELECT CASE WHEN first.v = 0 THEN NULL ELSE round(last.v::numeric / first.v, 4) END
                            FROM (SELECT (e ->> 'visitors')::bigint AS v FROM jsonb_array_elements(v_steps) e
                                   WHERE e ->> 'step' = 'visitors') first,
                                 (SELECT (e ->> 'visitors')::bigint AS v FROM jsonb_array_elements(v_steps) e
                                   WHERE e ->> 'step' = 'purchases') last),
    'trafficDays', (SELECT count(*) FROM analytics.rollup_run rr WHERE rr.day BETWEEN p_from AND p_to),
    'asOf', clock_timestamp());
END $$;

CREATE FUNCTION analytics.admin_places(p_level text, p_country text, p_region text, p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := core.admin_actor();
  v_days  int := analytics.range_days(p_from, p_to);
  v_items jsonb;
BEGIN
  IF p_level IS NULL OR p_level NOT IN ('country', 'region', 'city') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'level is country, region or city');
  END IF;
  IF (p_country IS NOT NULL AND p_country !~ '^([A-Z]{2}|Other)$')
     OR (p_region IS NOT NULL AND p_region <> '' AND NOT analytics.label_ok(p_region)) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'the place filter is not valid');
  END IF;
  WITH rows AS (
    SELECT r.dimension_value AS v, r.metric, sum(r.count) AS n
      FROM analytics.daily_rollup r
     WHERE r.dimension_kind = p_level AND r.day BETWEEN p_from AND p_to
       AND r.metric IN ('visitors', 'sign_ups', 'purchases')
       AND (p_country IS NULL OR split_part(r.dimension_value, '|', 1) = p_country)
       AND (p_region IS NULL OR p_level = 'country' OR split_part(r.dimension_value, '|', 2) = p_region)
     GROUP BY r.dimension_value, r.metric
  ),
  places AS (
    SELECT rows.v,
           COALESCE(sum(rows.n) FILTER (WHERE rows.metric = 'visitors'), 0) AS visitors,
           COALESCE(sum(rows.n) FILTER (WHERE rows.metric = 'sign_ups'), 0) AS sign_ups,
           COALESCE(sum(rows.n) FILTER (WHERE rows.metric = 'purchases'), 0) AS purchases
      FROM rows GROUP BY rows.v
  )
  SELECT jsonb_agg(jsonb_build_object(
           'country', split_part(p.v, '|', 1),
           'region', CASE WHEN p_level = 'country' THEN NULL ELSE NULLIF(split_part(p.v, '|', 2), '') END,
           'city', CASE WHEN p_level = 'city' THEN NULLIF(split_part(p.v, '|', 3), '') END,
           'visitors', p.visitors, 'signUps', p.sign_ups, 'purchases', p.purchases)
         ORDER BY p.visitors DESC, p.v)
    INTO v_items FROM places p;
  RETURN jsonb_build_object(
    'level', p_level, 'country', p_country, 'region', p_region, 'from', p_from, 'to', p_to, 'days', v_days,
    'minVisitors', analytics.place_min_visitors(), 'items', COALESCE(v_items, '[]'::jsonb),
    'trafficDays', (SELECT count(*) FROM analytics.rollup_run rr WHERE rr.day BETWEEN p_from AND p_to),
    'asOf', clock_timestamp());
END $$;

CREATE FUNCTION analytics.admin_top(p_kind text, p_from date, p_to date, p_limit int) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := core.admin_actor();
  v_days  int := analytics.range_days(p_from, p_to);
  v_items jsonb;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('product', 'company', 'category') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'kind is product, company or category');
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'limit is 1 to 50');
  END IF;
  WITH lines AS (
    SELECT ol.product_id, so.company_id, so.order_group_id, p.category,
           ol.list_paise - ol.seller_discount_paise - ol.platform_discount_paise AS paid
      FROM core.order_line ol
      JOIN core.seller_order so ON so.id = ol.seller_order_id AND so.status = 'COMPLETED'
      JOIN core.order_group g ON g.id = so.order_group_id AND g.buyer_source = 'PLAYER'
      JOIN core.product p ON p.id = ol.product_id
     WHERE g.created_at >= analytics.utc_start(p_from) AND g.created_at < analytics.utc_start(p_to + 1)
  ),
  grouped AS (
    SELECT CASE p_kind WHEN 'product' THEN l.product_id::text WHEN 'company' THEN l.company_id::text
                       ELSE l.category END AS k,
           count(DISTINCT l.order_group_id) AS orders, count(*) AS units, sum(l.paid)::bigint AS paise
      FROM lines l
     GROUP BY 1
     ORDER BY 4 DESC, 2 DESC, 1
     LIMIT p_limit
  )
  SELECT jsonb_agg(
           CASE p_kind
             WHEN 'product' THEN jsonb_build_object(
               'productId', gr.k, 'name', pv.name, 'category', pr.category,
               'shop', CASE WHEN co.id IS NULL THEN NULL
                            ELSE jsonb_build_object('name', co.name, 'handle', co.handle) END)
             WHEN 'company' THEN jsonb_build_object(
               'companyId', gr.k,
               'shop', CASE WHEN co.id IS NULL THEN NULL
                            ELSE jsonb_build_object('name', co.name, 'handle', co.handle) END)
             ELSE jsonb_build_object('category', gr.k)
           END || jsonb_build_object('orders', gr.orders, 'units', gr.units, 'spendPaise', gr.paise::text)
           ORDER BY gr.paise DESC, gr.orders DESC, gr.k)
    INTO v_items
    FROM grouped gr
    LEFT JOIN core.product pr ON pr.id = CASE WHEN p_kind = 'product' THEN gr.k::uuid END
    LEFT JOIN core.product_version pv ON pv.id = pr.current_version_id
    LEFT JOIN core.company co ON co.id = CASE p_kind WHEN 'product' THEN pr.company_id
                                                     WHEN 'company' THEN gr.k::uuid END;
  RETURN jsonb_build_object('kind', p_kind, 'from', p_from, 'to', p_to, 'days', v_days, 'limit', p_limit,
                            'items', COALESCE(v_items, '[]'::jsonb), 'asOf', clock_timestamp());
END $$;

-- ---------------------------------------------------------------- synthetic data (owner only)
-- DEVELOPMENT ONLY: p_days days of plausible synthetic traffic ending today, across Indian states
-- and cities (one deliberately tiny town, which the rollup folds into 'Other'), then rolled up.
-- Never granted to any role; scripts/dev-setup.ts calls it as the owner when SEED_ANALYTICS=1.
CREATE FUNCTION analytics.dev_seed_synthetic_events(p_days int) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_today    date := analytics.utc_today();
  v_day      date;
  v_events   bigint := 0;
  v_products uuid[];
  v_n        bigint;
BEGIN
  IF p_days IS NULL OR p_days NOT BETWEEN 1 AND 60 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'p_days is 1 to 60');
  END IF;
  SELECT array_agg(p.id ORDER BY p.id) INTO v_products
    FROM (SELECT p.id FROM core.product p WHERE p.status = 'PUBLISHED' ORDER BY p.id LIMIT 40) p;
  FOR i IN REVERSE p_days - 1 .. 0 LOOP
    v_day := v_today - i;
    WITH place(country, region, city, weight) AS (
      VALUES ('IN', 'MH', 'Mumbai', 22), ('IN', 'MH', 'Pune', 10), ('IN', 'KA', 'Bengaluru', 20),
             ('IN', 'DL', 'New Delhi', 16), ('IN', 'TN', 'Chennai', 9), ('IN', 'TG', 'Hyderabad', 11),
             ('IN', 'WB', 'Kolkata', 7), ('IN', 'GJ', 'Ahmedabad', 5), ('IN', 'KL', 'Kochi', 3)
    ),
    visitors AS (
      SELECT v, decode(md5(random()::text || v || v_day::text), 'hex') AS key,
             (ARRAY['mobile', 'mobile', 'mobile', 'desktop', 'desktop', 'tablet'])[1 + floor(random() * 6)::int] AS dev,
             random() < 0.3 AS signed_in, random() AS pick
        FROM generate_series(1, 120 + floor(random() * 80)::int) v
    ),
    placed AS (
      -- a weighted pick; the tiny town gets two visitors a day
      SELECT vi.*, pl.country, pl.region, pl.city
        FROM visitors vi
        JOIN LATERAL (
          SELECT p.* FROM (SELECT place.*, sum(weight) OVER (ORDER BY weight DESC, city) AS cum,
                                  sum(weight) OVER () AS total FROM place) p
           WHERE p.cum >= vi.pick * p.total ORDER BY p.cum LIMIT 1) pl ON vi.v > 2
      UNION ALL
      SELECT vi.*, 'IN', 'HP', 'Kaza' FROM visitors vi WHERE vi.v <= 2
    ),
    acts AS (
      SELECT pl.*, a.name, a.props,
             date_trunc('minute', analytics.utc_start(v_day) + make_interval(secs => floor(random() * 86000))) AS at
        FROM placed pl
       CROSS JOIN LATERAL (
         -- every branch names pl.v, so each visitor draws its own random actions
         SELECT 'page_view' AS name, '{}'::jsonb AS props
           FROM generate_series(1, 1 + floor(random() * 5)::int + 0 * pl.v)
         UNION ALL
         SELECT 'search', jsonb_build_object('result_count_bucket', (ARRAY['0', '1-5', '6-20', '21+'])[1 + floor(random() * 4)::int],
                                             'query_length_bucket', (ARRAY['1-3', '4-10', '11-30'])[1 + floor(random() * 3)::int])
          WHERE pl.v > 0 AND random() < 0.4
         UNION ALL
         SELECT 'product_view', jsonb_build_object('product_id', v_products[1 + floor(random() * cardinality(v_products))::int])
           FROM generate_series(1, floor(random() * 4)::int + 0 * pl.v) WHERE cardinality(v_products) > 0
         UNION ALL
         SELECT 'cart_add', jsonb_build_object('product_id', v_products[1 + floor(random() * cardinality(v_products))::int])
          WHERE pl.v > 0 AND cardinality(v_products) > 0 AND random() < 0.25
         UNION ALL
         SELECT 'checkout_start', jsonb_build_object('item_count', 1 + floor(random() * 3)::int, 'amount_bucket', '10k_1l')
          WHERE pl.v > 0 AND random() < 0.12
         UNION ALL
         SELECT 'purchase', jsonb_build_object('item_count', 1, 'amount_bucket', '10k_1l') WHERE pl.v > 0 AND random() < 0.07
         UNION ALL
         SELECT 'sign_up', '{}'::jsonb WHERE pl.v > 0 AND random() < 0.04
       ) a
    )
    INSERT INTO analytics.event (occurred_at, day, name, surface, visitor_key, signed_in, country, region, city,
                                 device_class, props)
    SELECT a.at, v_day, a.name,
           CASE WHEN a.name IN ('checkout_start', 'purchase') THEN 'checkout'
                WHEN a.name = 'sign_up' THEN 'account' ELSE 'shop' END,
           a.key, a.signed_in OR a.name IN ('purchase', 'sign_up'), a.country, a.region, a.city, a.dev,
           CASE WHEN a.props ? 'product_id' THEN
                  a.props || COALESCE((SELECT jsonb_strip_nulls(jsonb_build_object('category', p.category,
                                                                                   'company_id', p.company_id))
                                         FROM core.product p WHERE p.id = (a.props ->> 'product_id')::uuid
                                          AND p.category ~ '^[a-z0-9-]{1,40}$'), '{}'::jsonb)
                ELSE a.props END
      FROM acts a;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_events := v_events + v_n;
    PERFORM analytics.rollup_day(v_day);
  END LOOP;
  RETURN jsonb_build_object('days', p_days, 'events', v_events);
END $$;

-- ---------------------------------------------------------------- privileges
REVOKE ALL ON FUNCTION
  analytics.event_names(), analytics.label_ok(text), analytics.props_valid(text, jsonb), analytics.guard_event(),
  analytics.raw_retention_days(), analytics.place_min_visitors(), analytics.max_range_days(), analytics.utc_today(),
  analytics.record_event(text, text, bytea, text, text, text, text, jsonb), analytics.on_listing_published(),
  analytics.on_creator_unlocked(),
  analytics.rollup_day(date), analytics.purge_events(), core.analytics_rollup_job(), core.analytics_purge_job(),
  analytics.range_days(date, date), analytics.utc_start(date), analytics.period_totals(date, date),
  analytics.admin_overview(date, date), analytics.admin_timeseries(text, date, date),
  analytics.admin_funnel(date, date), analytics.admin_places(text, text, text, date, date),
  analytics.admin_top(text, date, date, int), analytics.dev_seed_synthetic_events(int)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION analytics.record_event(text, text, bytea, text, text, text, text, jsonb),
  analytics.admin_overview(date, date), analytics.admin_timeseries(text, date, date),
  analytics.admin_funnel(date, date), analytics.admin_places(text, text, text, date, date),
  analytics.admin_top(text, date, date, int)
TO app_web;
GRANT EXECUTE ON FUNCTION core.analytics_rollup_job(), core.analytics_purge_job() TO app_jobs;

COMMENT ON FUNCTION analytics.dev_seed_synthetic_events(int) IS
  'DEVELOPMENT ONLY: synthetic analytics events for the local console. Owner only; never granted.';
