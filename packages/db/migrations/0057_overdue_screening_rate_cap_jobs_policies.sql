-- Seventh security review, minors 5b, 7b and 7c.
--
-- 5b. Moderation overdue counts submissions stuck in SCREENING again. 0046 counted only those
--     waiting for review (NEEDS_REVIEW), so a stalled screening job left listings unpublished with
--     nobody told. core.moderation_screening_stalled() -> {count, oldestAgeSeconds,
--     oldestSubmittedAt, thresholdHours}: SCREENING submissions older than
--     `moderation_safety_net_hours` (48) and the age of the oldest one in SCREENING.
--       * core.admin_status() reports it separately as `screeningStalled`; every earlier field
--         (moderationOverdue included, still about NEEDS_REVIEW) is unchanged.
--       * core.moderation_safety_net() is overdue when either is: `count` is their sum, and the
--         answer adds `screeningStalled` (the stalled count); the once-per-UTC-day SYSTEM audit row
--         ('moderation.overdue') names both counts. It still never touches a switch.
-- 7b. The rate counter cap never evicts a live window. core.rate_purge deletes the windows that have
--     ended (and those older than `older_than`), as before; if the table is still over
--     `rate_counter_max_rows` (200000) after that, it deletes nothing more and writes one SYSTEM
--     audit row ('rate.over_cap') per UTC hour instead.
-- 7c. The allow-all policies left for app_jobs (`jobs_all` USING (true), and the read/insert ones of
--     0012-0034) are dropped: since 0047 app_jobs holds no table privilege and works only through
--     definer functions, so they granted nothing; they must not come back to life with a grant.

-- ---------------------------------------------------------------- 5b
CREATE FUNCTION core.moderation_screening_stalled() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH cfg AS (SELECT core.config_int(core.current_config_id(), ARRAY['moderation_safety_net_hours'], 48)::int AS hours),
  waiting AS (SELECT s.submitted_at FROM core.listing_submission s WHERE s.state = 'SCREENING')
  SELECT jsonb_build_object(
    'count', (SELECT count(*) FROM waiting w, cfg WHERE w.submitted_at < clock_timestamp() - make_interval(hours => cfg.hours)),
    'oldestSubmittedAt', (SELECT min(w.submitted_at) FROM waiting w),
    'oldestAgeSeconds', (SELECT floor(extract(epoch FROM clock_timestamp() - min(w.submitted_at)))::bigint FROM waiting w),
    'thresholdHours', (SELECT cfg.hours FROM cfg))
$$;

CREATE OR REPLACE FUNCTION core.moderation_safety_net() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_over    jsonb := core.moderation_overdue();
  v_stall   jsonb := core.moderation_screening_stalled();
  v_review  bigint := (v_over ->> 'count')::bigint;
  v_stalled bigint := (v_stall ->> 'count')::bigint;
  v_count   bigint := v_review + v_stalled;
  v_today   timestamptz := date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_audited boolean := false;
BEGIN
  PERFORM ledger.require_read_committed();
  IF v_count > 0 THEN
    -- one row per UTC day, whatever the number of runs: concurrent runs take turns here
    PERFORM core.lock_actor('core.moderation_overdue', '00000000-0000-0000-0000-000000000000'::uuid);
    IF NOT EXISTS (SELECT 1 FROM audit.audit_log l
                    WHERE l.action = 'moderation.overdue' AND l.actor_kind = 'SYSTEM' AND l.created_at >= v_today) THEN
      PERFORM audit.append_chained(NULL, 'SYSTEM', 'moderation.overdue', 'moderation_queue',
        CASE WHEN v_review > 0 THEN 'NEEDS_REVIEW' ELSE 'SCREENING' END,
        format('%s listing(s) have waited for review and %s for screening longer than %s hours',
               v_review, v_stalled, v_over ->> 'thresholdHours'),
        jsonb_build_object('count', v_review, 'oldestSubmittedAt', v_over -> 'oldestSubmittedAt',
                           'screeningStalled', v_stalled,
                           'screeningOldestSubmittedAt', v_stall -> 'oldestSubmittedAt',
                           'thresholdHours', v_over -> 'thresholdHours'));
      v_audited := true;
    END IF;
  END IF;
  RETURN jsonb_build_object('overdue', v_count > 0, 'count', v_count,
                            'oldestAgeSeconds', GREATEST((v_over ->> 'oldestAgeSeconds')::bigint,
                                                         (v_stall ->> 'oldestAgeSeconds')::bigint),
                            'screeningStalled', v_stalled, 'audited', v_audited);
END $$;

CREATE OR REPLACE FUNCTION core.admin_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := core.admin_actor();   -- FORBIDDEN for anyone else, before anything is read
  v_sw    core.system_switch;
BEGIN
  SELECT * INTO v_sw FROM core.system_switch sw WHERE sw.name = 'publication';
  RETURN jsonb_build_object(
    'publication', jsonb_build_object('enabled', COALESCE(v_sw.enabled, false), 'updatedAt', v_sw.updated_at),
    'moderationOverdue', core.moderation_overdue(),
    'screeningStalled', core.moderation_screening_stalled(),
    'needsReview', (SELECT count(*) FROM core.listing_submission s WHERE s.state = 'NEEDS_REVIEW'),
    'openReportCases', (SELECT count(*) FROM core.report_case rc WHERE rc.status = 'OPEN'),
    'openAppeals', (SELECT count(*) FROM core.appeal a WHERE a.status = 'OPEN'));
END $$;

REVOKE ALL ON FUNCTION core.moderation_screening_stalled() FROM PUBLIC;

-- ---------------------------------------------------------------- 7b
CREATE OR REPLACE FUNCTION core.rate_purge(older_than interval DEFAULT '2 days') RETURNS int
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n     int;
  total bigint;
  cap   bigint := core.config_int(core.current_config_id(), ARRAY['rate_counter_max_rows'], 200000);
  hour  timestamptz := date_trunc('hour', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
BEGIN
  IF older_than IS NULL OR older_than < interval '2 days' THEN
    PERFORM core.fail('VALIDATION_FAILED', 'older_than is at least two days');
  END IF;
  -- ended windows only (a window older than two days has always ended: windows are at most a day)
  DELETE FROM core.rate_counter rc
   WHERE rc.window_start < clock_timestamp() - older_than
      OR rc.window_start + make_interval(secs => rc.window_seconds) <= clock_timestamp();
  GET DIAGNOSTICS n = ROW_COUNT;
  SELECT count(*) INTO total FROM core.rate_counter;
  IF total > cap THEN
    -- every row left is a live window: none is evicted; the overflow is recorded once per hour
    PERFORM core.lock_actor('core.rate_counter', '00000000-0000-0000-0000-000000000000'::uuid);
    IF NOT EXISTS (SELECT 1 FROM audit.audit_log l
                    WHERE l.action = 'rate.over_cap' AND l.actor_kind = 'SYSTEM' AND l.created_at >= hour) THEN
      PERFORM audit.append_chained(NULL, 'SYSTEM', 'rate.over_cap', 'rate_counter', 'core.rate_counter',
        format('%s live rate windows exceed the cap of %s; none was evicted', total, cap),
        jsonb_build_object('rows', total, 'cap', cap));
    END IF;
  END IF;
  RETURN n;
END $$;

-- ---------------------------------------------------------------- 7c
DROP POLICY jobs_all ON analytics.experiment;
DROP POLICY jobs_all ON analytics.experiment_exposure;
DROP POLICY jobs_all ON analytics.metric_daily;
DROP POLICY jobs_all ON analytics.metric_hourly;
DROP POLICY jobs_all ON audit.audit_log;
DROP POLICY jobs_all ON audit.consumer_receipt;
DROP POLICY jobs_all ON audit.outbox;
DROP POLICY jobs_all ON audit.pending_action;
DROP POLICY jobs_all ON core.bank_account;
DROP POLICY jobs_all ON core.checkout_session;
DROP POLICY jobs_all ON core.company;
DROP POLICY jobs_all ON core.config_version;
DROP POLICY jobs_all ON core.coupon;
DROP POLICY jobs_all ON core.coupon_lookup_failure;
DROP POLICY jobs_all ON core.coupon_redemption;
DROP POLICY jobs_all ON core.creator_entitlement;
DROP POLICY jobs_all ON core.fictional_landmark;
DROP POLICY jobs_all ON core.fictional_locality;
DROP POLICY jobs_all ON core.idempotency_record;
DROP POLICY jobs_all ON core.inventory_unit;
DROP POLICY jobs_all ON core.membership;
DROP POLICY jobs_all ON core.order_group;
DROP POLICY jobs_all ON core.order_line;
DROP POLICY jobs_all ON core.ownership;
DROP POLICY jobs_all ON core.payment_attempt;
DROP POLICY jobs_all ON core.payment_challenge;
DROP POLICY jobs_all ON core.product;
DROP POLICY jobs_all ON core.product_version;
DROP POLICY jobs_all ON core.promo_campaign;
DROP POLICY jobs_all ON core.seller_order;
DROP POLICY jobs_all ON core.shipment;
DROP POLICY jobs_all ON core.system_switch;
DROP POLICY jobs_all ON core.user_profile;
DROP POLICY jobs_all ON core.virtual_card;
DROP POLICY jobs_all ON core.warehouse;
DROP POLICY jobs_all ON ledger.grant_record;
DROP POLICY jobs_all ON ledger.journal;
DROP POLICY jobs_all ON ledger.ledger_account;
DROP POLICY jobs_all ON ledger.posting;
DROP POLICY jobs_all ON ledger.wallet;
DROP POLICY jobs_read ON ledger.journal_seal;
DROP POLICY jobs_read ON core.order_group_seal;
DROP POLICY jobs_read ON core.identity_tombstone;
DROP POLICY jobs_insert ON core.identity_tombstone;
DROP POLICY jobs_purge_expired ON core.identity_tombstone;
DROP POLICY jobs_read ON core.category;
DROP POLICY jobs_read ON core.formation_sponsorship;
DROP POLICY jobs_read ON core.company_registration;

-- the tables whose only policies those were keep row-level security with an explicit deny-all
-- policy (only the owner, through the definer functions, reads or writes them)
CREATE POLICY owner_only ON analytics.metric_daily USING (false) WITH CHECK (false);
CREATE POLICY owner_only ON analytics.metric_hourly USING (false) WITH CHECK (false);
CREATE POLICY owner_only ON audit.consumer_receipt USING (false) WITH CHECK (false);
CREATE POLICY owner_only ON audit.outbox USING (false) WITH CHECK (false);
CREATE POLICY owner_only ON core.company_registration USING (false) WITH CHECK (false);
CREATE POLICY owner_only ON core.coupon_lookup_failure USING (false) WITH CHECK (false);
CREATE POLICY owner_only ON core.formation_sponsorship USING (false) WITH CHECK (false);
CREATE POLICY owner_only ON core.identity_tombstone USING (false) WITH CHECK (false);
CREATE POLICY owner_only ON core.order_group_seal USING (false) WITH CHECK (false);
CREATE POLICY owner_only ON ledger.journal_seal USING (false) WITH CHECK (false);
