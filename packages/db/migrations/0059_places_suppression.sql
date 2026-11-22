-- PRD R7.1 usage by place: the minimum count applies to every row the Console shows.
--
-- The daily rollup (0052) folds a place below `analytics.place_min_visitors` into "Other" before
-- anything is stored, but the folded "Other" row can itself be below the minimum (one visitor was
-- seen), and it still carried that place's sign-ups and purchases. analytics.admin_places now, for
-- the period and filters asked:
--   1. keeps every row at or above the minimum as it is;
--   2. merges every row below it (an "Other" row included, at any level) into ONE "Other" row: the
--      filter's country and region where one was given, "Other" otherwise;
--   3. returns that row with its counts only when it reaches the minimum; otherwise with visitors,
--      sign-ups and purchases null and `suppressed: true` (the screen shows "Fewer than N").
-- Every row carries `suppressed`. The minimum comes from configuration, as before.

CREATE OR REPLACE FUNCTION analytics.admin_places(p_level text, p_country text, p_region text, p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := core.admin_actor();
  v_days  int := analytics.range_days(p_from, p_to);
  v_k     int := analytics.place_min_visitors();
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
  ),
  shown AS (
    SELECT jsonb_agg(jsonb_build_object(
             'country', split_part(p.v, '|', 1),
             'region', CASE WHEN p_level = 'country' THEN NULL ELSE NULLIF(split_part(p.v, '|', 2), '') END,
             'city', CASE WHEN p_level = 'city' THEN NULLIF(split_part(p.v, '|', 3), '') END,
             'visitors', p.visitors, 'signUps', p.sign_ups, 'purchases', p.purchases, 'suppressed', false)
           ORDER BY p.visitors DESC, p.v) AS items
      FROM places p WHERE p.visitors >= v_k
  ),
  folded AS (
    SELECT count(*) AS n, sum(p.visitors) AS visitors, sum(p.sign_ups) AS sign_ups, sum(p.purchases) AS purchases
      FROM places p WHERE p.visitors < v_k
  )
  SELECT s.items,
         CASE WHEN f.n = 0 THEN NULL ELSE
           jsonb_build_object(
             'country', COALESCE(p_country, 'Other'),
             'region', CASE WHEN p_level = 'country' THEN NULL ELSE COALESCE(NULLIF(p_region, ''), 'Other') END,
             'city', CASE WHEN p_level = 'city' THEN 'Other' END)
           || CASE WHEN f.visitors >= v_k
                   THEN jsonb_build_object('visitors', f.visitors, 'signUps', f.sign_ups, 'purchases', f.purchases,
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
    'minVisitors', v_k, 'items', v_items,
    'trafficDays', (SELECT count(*) FROM analytics.rollup_run rr WHERE rr.day BETWEEN p_from AND p_to),
    'asOf', clock_timestamp());
END $$;
