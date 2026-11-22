-- Analytics events that cannot be tied to a person (eighth security review: major 2, minors 3, 5, 6).
--
-- Major 2. Server-side events (purchase, sign_up, creator_unlock, shop_registered,
--   listing_published) are stored with NO visitor key and NO place key, their time truncated to the
--   HOUR, and no prop that names one account's action: purchase keeps only its amount bucket,
--   listing_published only its category (when it is a catalog category), the others nothing. The
--   table enforces it (event_server_unlinked). Existing rows are rewritten here the same way.
--   Funnel: the first four steps still count daily distinct visitors (summed over the days); the
--   "purchases" step now counts purchase EVENTS (a purchase carries no visitor), so one visitor who
--   buys twice counts twice. Each step says which (`unit`: 'visitors' or 'events'). Places count
--   sign-ups and purchases as events, as before.
-- Minor 3. Small-count suppression:
--   (a) the place minimum is at least 10 whatever the configuration says (GREATEST(setting, 10)),
--       and a configuration below 10 is refused (core.config_version CHECK);
--   (b) a place row is shown only when it reaches the minimum; its sign-up and purchase cells are
--       null when the value is below `analytics.cell_min_count` (default and floor 5) but above 0
--       (the screen shows "Fewer than N"); `minCellCount` is returned;
--   (c) the minimum counts distinct ADDRESS PREFIXES a day, not visitor keys: browser events carry
--       `place_key` (8 bytes, keyed hash of the address prefix only), and the rollup stores
--       `prefixes` (distinct place keys) beside `visitors`. Rollup rows written before this
--       migration have prefixes 0, so their places are suppressed (privacy first).
--       Place keys are forgotten (set to null) by the rollup job once their day has been rolled up
--       completely and is at least two days old; that day's rollup is then final (rollup_run.final)
--       and is never recomputed.
-- Minor 5. record_event and the table accept a region only as an ISO 3166-2 subdivision code part
--   (^[A-Z0-9]{1,3}$, what the edge's x-vercel-ip-country-region sends) and a city only as letters
--   of any script, combining marks, spaces, apostrophes, hyphens and dots (no digit, no symbol),
--   at most 64 characters (analytics.city_ok). Existing rows that do not pass lose the label.
--   `category` is no longer a search prop; a category prop elsewhere must be a catalog category
--   (checked against core.category inside the function and the trigger).
-- Minor 6. The visitor and place keys are keyed by a random per-day salt kept in the owner-only
--   analytics.daily_salt. analytics.today_salt() (app_web) returns only today's (UTC) salt,
--   creating it if absent; the purge job deletes salts older than yesterday, so an old day's keys
--   can never be recomputed. (The web server also keys them with ANALYTICS_KEY.)

-- ---------------------------------------------------------------- allow-lists
CREATE FUNCTION analytics.server_event_names() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['purchase', 'sign_up', 'creator_unlock', 'shop_registered', 'listing_published']
$$;

CREATE FUNCTION analytics.region_ok(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p IS NOT NULL AND p ~ '^[A-Z0-9]{1,3}$'
$$;

-- Letters of any script, combining marks, space, apostrophe, hyphen and dot; no digit or symbol.
-- (The web server's parsePlace applies the same rule with Unicode classes.)
CREATE FUNCTION analytics.city_ok(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT analytics.label_ok(p)
     AND p !~ '[!-&(-,/-@[-`{-¿×÷]'
     AND p !~ '[٠-٩۰-۹߀-߉०-९০-৯੦-੯૦-૯୦-୯௦-௯౦-౯೦-೯൦-൯෦-෯๐-๙໐-໙༠-༳၀-၉០-៩᠐-᠙]'
     AND p !~ '[‐-⯿　-〿＀-＠［-｀｛-･￠-￿]'
     AND p !~ '[\U0001D400-\U0001D7FF\U0001F000-\U0001FFFF]'
$$;

CREATE OR REPLACE FUNCTION analytics.props_valid(p_name text, p_props jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_props IS NOT NULL AND jsonb_typeof(p_props) = 'object' AND octet_length(p_props::text) <= 256
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_each(p_props) e
        WHERE e.key <> ALL (CASE p_name
                WHEN 'search'            THEN ARRAY['result_count_bucket', 'query_length_bucket']
                WHEN 'product_view'      THEN ARRAY['product_id', 'category', 'company_id']
                WHEN 'cart_add'          THEN ARRAY['product_id', 'category', 'company_id']
                WHEN 'listing_published' THEN ARRAY['category']
                WHEN 'checkout_start'    THEN ARRAY['item_count', 'amount_bucket']
                WHEN 'purchase'          THEN ARRAY['amount_bucket']
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

-- A catalog category's slug, or null.
CREATE FUNCTION analytics.known_category(p text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.slug FROM core.category c WHERE c.slug = p AND p ~ '^[a-z0-9-]{1,40}$'
$$;

-- ---------------------------------------------------------------- the table and its rows
ALTER TABLE analytics.event ADD COLUMN place_key bytea CHECK (place_key IS NULL OR octet_length(place_key) = 8);

ALTER TABLE analytics.event DROP CONSTRAINT event_check;
ALTER TABLE analytics.event DROP CONSTRAINT event_city_check;
ALTER TABLE analytics.event DROP CONSTRAINT event_region_check;
ALTER TABLE analytics.event DROP CONSTRAINT event_visitor_known;

-- the rewrite of existing rows (append-only otherwise: the guard is off only for this statement)
ALTER TABLE analytics.event DISABLE TRIGGER event_append_only;
UPDATE analytics.event e
   SET visitor_key = CASE WHEN e.name = ANY (analytics.server_event_names()) THEN NULL ELSE e.visitor_key END,
       occurred_at = CASE WHEN e.name = ANY (analytics.server_event_names())
                          THEN date_trunc('hour', e.occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                          ELSE e.occurred_at END,
       region = CASE WHEN analytics.region_ok(e.region) THEN e.region END,
       city = CASE WHEN analytics.city_ok(e.city) THEN e.city END,
       props = CASE e.name
                 WHEN 'purchase' THEN COALESCE((SELECT jsonb_object_agg(k.key, k.value) FROM jsonb_each(e.props) k
                                                  WHERE k.key = 'amount_bucket'), '{}'::jsonb)
                 WHEN 'listing_published' THEN CASE WHEN analytics.known_category(e.props ->> 'category') IS NOT NULL
                                                    THEN jsonb_build_object('category', e.props ->> 'category')
                                                    ELSE '{}'::jsonb END
                 WHEN 'sign_up' THEN '{}'::jsonb
                 WHEN 'creator_unlock' THEN '{}'::jsonb
                 WHEN 'shop_registered' THEN '{}'::jsonb
                 WHEN 'search' THEN e.props - 'category'
                 ELSE CASE WHEN e.props ? 'category' AND analytics.known_category(e.props ->> 'category') IS NULL
                           THEN e.props - 'category' ELSE e.props END
               END;
ALTER TABLE analytics.event ENABLE TRIGGER event_append_only;

ALTER TABLE analytics.event
  ADD CONSTRAINT event_props_valid CHECK (analytics.props_valid(name, props)),
  ADD CONSTRAINT event_region_code CHECK (region IS NULL OR analytics.region_ok(region)),
  ADD CONSTRAINT event_city_letters CHECK (city IS NULL OR analytics.city_ok(city)),
  -- a server event names no visitor and no place key and is placed in its hour only; every
  -- browser event has a visitor key
  ADD CONSTRAINT event_server_unlinked CHECK (
    CASE WHEN name = ANY (analytics.server_event_names())
         THEN visitor_key IS NULL AND place_key IS NULL AND mod(extract(epoch FROM occurred_at), 3600) = 0
         ELSE visitor_key IS NOT NULL END);

-- the guard: still append-only; the rollup job may only forget place keys
CREATE OR REPLACE FUNCTION analytics.guard_event() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('analytics.purging', true) = 'on' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND current_setting('analytics.forgetting', true) = 'on'
     AND NEW.place_key IS NULL
     AND (NEW.id, NEW.occurred_at, NEW.day, NEW.name, NEW.surface, NEW.visitor_key, NEW.signed_in, NEW.country,
          NEW.region, NEW.city, NEW.device_class, NEW.props)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.occurred_at, OLD.day, OLD.name, OLD.surface, OLD.visitor_key, OLD.signed_in, OLD.country,
          OLD.region, OLD.city, OLD.device_class, OLD.props) THEN
    RETURN NEW;
  END IF;
  PERFORM core.fail('FORBIDDEN', 'analytics events are append-only; only the retention purge deletes them');
  RETURN NULL;
END $$;

ALTER TABLE analytics.daily_rollup ADD COLUMN prefixes bigint NOT NULL DEFAULT 0 CHECK (prefixes >= 0);
ALTER TABLE analytics.rollup_run ADD COLUMN final boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------- configuration
CREATE OR REPLACE FUNCTION analytics.place_min_visitors() RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT GREATEST(core.config_int(core.current_config_id(), ARRAY['analytics', 'place_min_visitors'], 10), 10)::int
$$;

CREATE FUNCTION analytics.cell_min_count() RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT GREATEST(core.config_int(core.current_config_id(), ARRAY['analytics', 'cell_min_count'], 5), 5)::int
$$;

-- a configuration may raise the minimums, never lower them below the floors
ALTER TABLE core.config_version ADD CONSTRAINT config_analytics_minimums CHECK (
  CASE WHEN values #> '{analytics,place_min_visitors}' IS NULL THEN true
       WHEN jsonb_typeof(values #> '{analytics,place_min_visitors}') = 'number'
         THEN (values #>> '{analytics,place_min_visitors}')::numeric >= 10
       ELSE false END
  AND CASE WHEN values #> '{analytics,cell_min_count}' IS NULL THEN true
           WHEN jsonb_typeof(values #> '{analytics,cell_min_count}') = 'number'
             THEN (values #>> '{analytics,cell_min_count}')::numeric >= 5
           ELSE false END) NOT VALID;

-- ---------------------------------------------------------------- the daily salt
CREATE TABLE analytics.daily_salt (
  day  date PRIMARY KEY,
  salt bytea NOT NULL CHECK (octet_length(salt) = 32)
);
ALTER TABLE analytics.daily_salt ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON analytics.daily_salt USING (false) WITH CHECK (false);
REVOKE ALL ON analytics.daily_salt FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;

-- Today's (UTC) salt, created on first use: 32 bytes from two version-4 uuids (244 random bits).
CREATE FUNCTION analytics.today_salt() RETURNS TABLE (day date, salt bytea)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_day date := analytics.utc_today();
BEGIN
  INSERT INTO analytics.daily_salt AS s (day, salt)
  VALUES (v_day, pg_catalog.sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid())))
  ON CONFLICT ON CONSTRAINT daily_salt_pkey DO NOTHING;
  RETURN QUERY SELECT s.day, s.salt FROM analytics.daily_salt s WHERE s.day = v_day;
END $$;

-- ---------------------------------------------------------------- capture
DROP FUNCTION analytics.record_event(text, text, bytea, text, text, text, text, jsonb);

CREATE FUNCTION analytics.record_event(p_name text, p_surface text, p_visitor_key bytea, p_place_key bytea,
                                       p_country text, p_region text, p_city text, p_device_class text,
                                       p_props jsonb)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_actor   uuid := core.actor_id();
  v_server  boolean := p_name = ANY (analytics.server_event_names());
  v_now     timestamptz;
  v_props   jsonb := COALESCE(p_props, '{}'::jsonb);
  v_product record;
BEGIN
  IF p_name IS NULL OR p_name <> ALL (analytics.event_names()) OR p_name = 'listing_published' THEN
    PERFORM core.fail('VALIDATION_FAILED', 'unknown event name');
  END IF;
  IF v_server AND v_actor IS NULL THEN
    PERFORM core.fail('VALIDATION_FAILED', 'a server event needs a signed-in actor');
  END IF;
  IF p_surface IS NULL OR p_surface NOT IN ('shop', 'account', 'checkout', 'studio', 'console') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'unknown surface');
  END IF;
  IF v_server AND (p_visitor_key IS NOT NULL OR p_place_key IS NOT NULL) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'a server event carries no visitor or place key');
  END IF;
  IF NOT v_server AND (p_visitor_key IS NULL OR octet_length(p_visitor_key) <> 16
                       OR p_place_key IS NULL OR octet_length(p_place_key) <> 8) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'the visitor key is 16 bytes and the place key 8');
  END IF;
  IF p_country IS NULL OR p_country !~ '^[A-Z]{2}$'
     OR (p_region IS NOT NULL AND NOT analytics.region_ok(p_region))
     OR (p_city IS NOT NULL AND NOT analytics.city_ok(p_city))
     OR (p_country = 'ZZ' AND (p_region IS NOT NULL OR p_city IS NOT NULL)) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'the place is not valid');
  END IF;
  IF p_device_class IS NULL OR p_device_class NOT IN ('mobile', 'tablet', 'desktop', 'unknown') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'unknown device class');
  END IF;
  IF NOT analytics.props_valid(p_name, v_props) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'the props are not allowed for this event');
  END IF;
  IF v_props ? 'category' AND analytics.known_category(v_props ->> 'category') IS NULL
     AND p_name NOT IN ('product_view', 'cart_add') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'the category is not a catalog category');
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
    v_props := jsonb_strip_nulls(jsonb_build_object('product_id', v_product.id, 'company_id', v_product.company_id,
                                                    'category', analytics.known_category(v_product.category)));
  ELSIF p_name = 'shop_registered' THEN
    IF NOT EXISTS (SELECT 1 FROM core.company c WHERE c.owner_user_id = v_actor) THEN
      PERFORM core.fail('VALIDATION_FAILED', 'the actor has no company');
    END IF;
  END IF;

  v_now := CASE WHEN v_server THEN date_trunc('hour', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                ELSE date_trunc('minute', clock_timestamp()) END;
  INSERT INTO analytics.event (occurred_at, day, name, surface, visitor_key, place_key, signed_in, country, region,
                               city, device_class, props)
  VALUES (v_now, (v_now AT TIME ZONE 'UTC')::date, p_name, p_surface, p_visitor_key, p_place_key, v_actor IS NOT NULL,
          p_country, p_region, p_city, p_device_class, v_props);
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION analytics.on_listing_published() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_now timestamptz := date_trunc('hour', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_cat text;
BEGIN
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM core.company c JOIN core.user_profile up ON up.id = c.owner_user_id
                    WHERE c.id = NEW.company_id AND (up.research_opt_out OR up.is_test_account)) THEN
      v_cat := analytics.known_category(NEW.category);
      INSERT INTO analytics.event (occurred_at, day, name, surface, visitor_key, signed_in, country, region, city,
                                   device_class, props)
      VALUES (v_now, (v_now AT TIME ZONE 'UTC')::date, 'listing_published', 'studio', NULL, true, 'ZZ', NULL, NULL,
              'unknown', CASE WHEN v_cat IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('category', v_cat) END);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL; -- analytics never blocks publication
  END;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION analytics.on_creator_unlocked() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_now timestamptz := date_trunc('hour', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
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

-- ---------------------------------------------------------------- rollup
CREATE OR REPLACE FUNCTION analytics.rollup_day(p_day date) RETURNS jsonb
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
  IF EXISTS (SELECT 1 FROM analytics.rollup_run rr WHERE rr.day = p_day AND rr.final) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'that day''s place keys are forgotten; its rollup is final');
  END IF;
  SELECT count(*) INTO v_events FROM analytics.event e WHERE e.day = p_day;
  -- the run row is the lock: concurrent rollups of one day take turns
  INSERT INTO analytics.rollup_run AS rr (day, computed_at, events, min_visitors)
  VALUES (p_day, v_now, v_events, v_k)
  ON CONFLICT (day) DO UPDATE SET computed_at = EXCLUDED.computed_at, events = EXCLUDED.events,
                                  min_visitors = EXCLUDED.min_visitors;
  DELETE FROM analytics.daily_rollup r WHERE r.day = p_day;

  WITH ev AS (
    SELECT e.name, e.surface, e.device_class, e.visitor_key, e.place_key, e.props,
           e.country AS c, COALESCE(e.region, '') AS r, COALESCE(e.city, '') AS t
      FROM analytics.event e WHERE e.day = p_day
  ),
  -- the minimum counts distinct address prefixes (place keys) of browser events, never visitor keys
  cv AS (SELECT ev.c, count(DISTINCT ev.place_key) AS v FROM ev GROUP BY ev.c),
  rv AS (SELECT ev.c, ev.r, count(DISTINCT ev.place_key) AS v FROM ev GROUP BY ev.c, ev.r),
  tv AS (SELECT ev.c, ev.r, ev.t, count(DISTINCT ev.place_key) AS v FROM ev GROUP BY ev.c, ev.r, ev.t),
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
    SELECT m.metric, d.kind, d.value, m.visitor_key, m.place_key
      FROM metric m
     CROSS JOIN LATERAL (VALUES
       ('none', ''),
       ('country', m.c1),
       ('region', m.c1 || '|' || m.r1),
       ('city', m.c1 || '|' || m.r1 || '|' || m.t1),
       ('surface', m.surface),
       ('device_class', m.device_class),
       ('category', CASE WHEN m.metric <> 'visitors' THEN m.props ->> 'category' END),
       ('product', CASE WHEN m.metric <> 'visitors' THEN m.props ->> 'product_id' END),
       ('company', CASE WHEN m.metric <> 'visitors' THEN m.props ->> 'company_id' END)) d(kind, value)
     WHERE d.value IS NOT NULL
  )
  INSERT INTO analytics.daily_rollup (day, metric, dimension_kind, dimension_value, count, visitors, prefixes,
                                      computed_at)
  SELECT p_day, dim.metric, dim.kind, dim.value,
         CASE WHEN dim.metric = 'visitors' THEN count(DISTINCT dim.visitor_key) ELSE count(*) END,
         count(DISTINCT dim.visitor_key), count(DISTINCT dim.place_key), v_now
    FROM dim
   GROUP BY dim.metric, dim.kind, dim.value;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('day', p_day, 'events', v_events, 'rows', v_rows, 'minVisitors', v_k);
END $$;

-- Forgets the place keys of every day at least two days old (rolling the day up first when its
-- last rollup ran before the day ended), and makes those days' rollups final. Returns the days.
CREATE FUNCTION analytics.forget_place_keys() RETURNS int
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '5s' AS $$
DECLARE
  v_today date := analytics.utc_today();
  v_day   date;
  v_n     int := 0;
BEGIN
  FOR v_day IN SELECT DISTINCT e.day FROM analytics.event e
                WHERE e.place_key IS NOT NULL AND e.day <= v_today - 2 ORDER BY 1 LOOP
    IF v_day >= v_today - analytics.raw_retention_days()
       AND NOT EXISTS (SELECT 1 FROM analytics.rollup_run rr
                        WHERE rr.day = v_day AND (rr.final OR rr.computed_at >= analytics.utc_start(v_day + 1))) THEN
      PERFORM analytics.rollup_day(v_day);
    END IF;
    PERFORM set_config('analytics.forgetting', 'on', true);
    UPDATE analytics.event e SET place_key = NULL WHERE e.day = v_day AND e.place_key IS NOT NULL;
    PERFORM set_config('analytics.forgetting', 'off', true);
    v_n := v_n + 1;
  END LOOP;
  UPDATE analytics.rollup_run rr SET final = true WHERE rr.day <= v_today - 2 AND NOT rr.final;
  RETURN v_n;
END $$;

CREATE OR REPLACE FUNCTION core.analytics_rollup_job() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_today date := analytics.utc_today();
  v_out   jsonb;
BEGIN
  v_out := jsonb_build_object('yesterday', analytics.rollup_day(v_today - 1), 'today', analytics.rollup_day(v_today));
  RETURN v_out || jsonb_build_object('placeKeysForgottenDays', analytics.forget_place_keys());
END $$;

-- Deletes raw events past retention (rollups are kept) and the salts older than yesterday.
CREATE OR REPLACE FUNCTION analytics.purge_events() RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '5s' AS $$
DECLARE
  n bigint;
BEGIN
  PERFORM set_config('analytics.purging', 'on', true);
  DELETE FROM analytics.event e WHERE e.day < analytics.utc_today() - analytics.raw_retention_days();
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('analytics.purging', 'off', true);
  DELETE FROM analytics.daily_salt s WHERE s.day < analytics.utc_today() - 1;
  RETURN n;
END $$;

-- ---------------------------------------------------------------- reads
CREATE OR REPLACE FUNCTION analytics.admin_funnel(p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := core.admin_actor();
  v_days  int := analytics.range_days(p_from, p_to);
  v_steps jsonb;
BEGIN
  WITH s AS (
    -- the browser steps count daily distinct visitors; purchases carry no visitor, so they count events
    SELECT st.ord, st.step, st.unit,
           (SELECT COALESCE(sum(CASE WHEN st.unit = 'events' THEN r.count ELSE r.visitors END), 0)
              FROM analytics.daily_rollup r
             WHERE r.metric = st.step AND r.dimension_kind = 'none' AND r.day BETWEEN p_from AND p_to) AS visitors
      FROM (VALUES (1, 'visitors', 'visitors'), (2, 'product_views', 'visitors'), (3, 'cart_adds', 'visitors'),
                   (4, 'checkout_starts', 'visitors'), (5, 'purchases', 'events')) st(ord, step, unit)
  ),
  w AS (SELECT s.*, lag(s.visitors) OVER (ORDER BY s.ord) AS prev FROM s)
  SELECT jsonb_agg(jsonb_build_object('step', w.step, 'visitors', w.visitors, 'unit', w.unit,
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

CREATE OR REPLACE FUNCTION analytics.admin_places(p_level text, p_country text, p_region text, p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := core.admin_actor();
  v_days  int := analytics.range_days(p_from, p_to);
  v_k     int := analytics.place_min_visitors();
  v_cell  int := analytics.cell_min_count();
  v_items jsonb;
  v_other jsonb;
BEGIN
  IF p_level IS NULL OR p_level NOT IN ('country', 'region', 'city') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'level is country, region or city');
  END IF;
  IF (p_country IS NOT NULL AND p_country !~ '^([A-Z]{2}|Other)$')
     OR (p_region IS NOT NULL AND p_region <> '' AND NOT analytics.label_ok(p_region)) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'the place filter is not valid');
  END IF;
  WITH rows AS (
    SELECT r.dimension_value AS v, r.metric, sum(r.count) AS n, sum(r.prefixes) AS prefixes
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
           COALESCE(sum(rows.prefixes) FILTER (WHERE rows.metric = 'visitors'), 0) AS prefixes,
           COALESCE(sum(rows.n) FILTER (WHERE rows.metric = 'sign_ups'), 0) AS sign_ups,
           COALESCE(sum(rows.n) FILTER (WHERE rows.metric = 'purchases'), 0) AS purchases
      FROM rows GROUP BY rows.v
  ),
  shown AS (
    SELECT jsonb_agg(jsonb_build_object(
             'country', split_part(p.v, '|', 1),
             'region', CASE WHEN p_level = 'country' THEN NULL ELSE NULLIF(split_part(p.v, '|', 2), '') END,
             'city', CASE WHEN p_level = 'city' THEN NULLIF(split_part(p.v, '|', 3), '') END,
             'visitors', p.visitors,
             'signUps', CASE WHEN p.sign_ups > 0 AND p.sign_ups < v_cell THEN NULL ELSE p.sign_ups END,
             'purchases', CASE WHEN p.purchases > 0 AND p.purchases < v_cell THEN NULL ELSE p.purchases END,
             'suppressed', false)
           ORDER BY p.visitors DESC, p.v) AS items
      FROM places p WHERE p.visitors >= v_k AND p.prefixes >= v_k
  ),
  folded AS (
    SELECT count(*) AS n, sum(p.visitors) AS visitors, sum(p.prefixes) AS prefixes, sum(p.sign_ups) AS sign_ups,
           sum(p.purchases) AS purchases
      FROM places p WHERE NOT (p.visitors >= v_k AND p.prefixes >= v_k)
  )
  SELECT s.items,
         CASE WHEN f.n = 0 THEN NULL ELSE
           jsonb_build_object(
             'country', COALESCE(p_country, 'Other'),
             'region', CASE WHEN p_level = 'country' THEN NULL ELSE COALESCE(NULLIF(p_region, ''), 'Other') END,
             'city', CASE WHEN p_level = 'city' THEN 'Other' END)
           || CASE WHEN f.visitors >= v_k AND f.prefixes >= v_k
                   THEN jsonb_build_object(
                          'visitors', f.visitors,
                          'signUps', CASE WHEN f.sign_ups > 0 AND f.sign_ups < v_cell THEN NULL ELSE f.sign_ups END,
                          'purchases', CASE WHEN f.purchases > 0 AND f.purchases < v_cell THEN NULL ELSE f.purchases END,
                          'suppressed', false)
                   ELSE jsonb_build_object('visitors', NULL, 'signUps', NULL, 'purchases', NULL, 'suppressed', true)
              END
         END
    INTO v_items, v_other
    FROM shown s, folded f;
  v_items := COALESCE(v_items, '[]'::jsonb);
  IF v_other IS NOT NULL THEN
    v_items := v_items || jsonb_build_array(v_other);
  END IF;
  RETURN jsonb_build_object(
    'level', p_level, 'country', p_country, 'region', p_region, 'from', p_from, 'to', p_to, 'days', v_days,
    'minVisitors', v_k, 'minCellCount', v_cell, 'items', v_items,
    'trafficDays', (SELECT count(*) FROM analytics.rollup_run rr WHERE rr.day BETWEEN p_from AND p_to),
    'asOf', clock_timestamp());
END $$;

-- ---------------------------------------------------------------- synthetic data (owner only)
-- As in 0052, with each visitor's address prefix (a few share one), server events without a
-- visitor, in their hour, and purchases carrying only their amount bucket.
CREATE OR REPLACE FUNCTION analytics.dev_seed_synthetic_events(p_days int) RETURNS jsonb
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
             -- one address prefix in ten is shared by two visitors
             substring(decode(md5(v_day::text || '|' || (CASE WHEN v % 10 = 1 AND v > 1 THEN v - 1 ELSE v END)::text),
                              'hex') FROM 1 FOR 8) AS pkey,
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
         SELECT 'purchase', jsonb_build_object('amount_bucket', '10k_1l') WHERE pl.v > 0 AND random() < 0.07
         UNION ALL
         SELECT 'sign_up', '{}'::jsonb WHERE pl.v > 0 AND random() < 0.04
       ) a
    )
    INSERT INTO analytics.event (occurred_at, day, name, surface, visitor_key, place_key, signed_in, country, region,
                                 city, device_class, props)
    SELECT CASE WHEN a.name = ANY (analytics.server_event_names()) THEN date_trunc('hour', a.at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                ELSE a.at END,
           v_day, a.name,
           CASE WHEN a.name IN ('checkout_start', 'purchase') THEN 'checkout'
                WHEN a.name = 'sign_up' THEN 'account' ELSE 'shop' END,
           CASE WHEN a.name = ANY (analytics.server_event_names()) THEN NULL ELSE a.key END,
           CASE WHEN a.name = ANY (analytics.server_event_names()) THEN NULL ELSE a.pkey END,
           a.signed_in OR a.name IN ('purchase', 'sign_up'), a.country, a.region, a.city, a.dev,
           CASE WHEN a.props ? 'product_id' THEN
                  a.props || COALESCE((SELECT jsonb_strip_nulls(jsonb_build_object(
                                                'category', analytics.known_category(p.category),
                                                'company_id', p.company_id))
                                         FROM core.product p WHERE p.id = (a.props ->> 'product_id')::uuid), '{}'::jsonb)
                ELSE a.props END
      FROM acts a;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_events := v_events + v_n;
    IF NOT EXISTS (SELECT 1 FROM analytics.rollup_run rr WHERE rr.day = v_day AND rr.final) THEN
      PERFORM analytics.rollup_day(v_day);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('days', p_days, 'events', v_events);
END $$;

-- ---------------------------------------------------------------- privileges
REVOKE ALL ON FUNCTION
  analytics.server_event_names(), analytics.region_ok(text), analytics.city_ok(text),
  analytics.known_category(text), analytics.cell_min_count(), analytics.today_salt(),
  analytics.record_event(text, text, bytea, bytea, text, text, text, text, jsonb), analytics.forget_place_keys()
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION analytics.record_event(text, text, bytea, bytea, text, text, text, text, jsonb),
  analytics.today_salt()
TO app_web;
