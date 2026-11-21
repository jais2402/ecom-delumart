-- The moderation safety net no longer pauses the platform (sixth security review, major 4). One
-- unreviewed listing switched publication off for everyone, and while it was off the Super Admin
-- could not approve the very listing that caused it.
--
--  * core.moderation_safety_net() (app_jobs) never touches a switch. When the oldest NEEDS_REVIEW
--    submission is older than `moderation_safety_net_hours` (48) it writes ONE SYSTEM row to the
--    audit chain per UTC day ('moderation.overdue'); items waiting for review simply stay
--    unpublished. Returns {overdue, count, oldestAgeSeconds, audited}.
--  * core.moderation_overdue() -> {count, oldestAgeSeconds, oldestSubmittedAt, thresholdHours}:
--    NEEDS_REVIEW submissions older than the threshold and the age of the oldest waiting one.
--  * The manual `publication` switch remains, and only stops automatic publication by the
--    screening job (core.screening_apply answers PAUSED; an approval waiting for stock is not
--    allocated). The Super Admin's APPROVE (core.admin_listing_decide) and restore
--    (core.admin_listing_restore; 0044: a dismissed case, an upheld appeal) work while it is off.
--  * core.admin_status() (Super Admin only, FORBIDDEN for anyone else before anything is read):
--    {publication: {enabled, updatedAt}, moderationOverdue, needsReview, openReportCases,
--    openAppeals} for the console.

-- ---------------------------------------------------------------- overdue
CREATE FUNCTION core.moderation_overdue() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH cfg AS (SELECT core.config_int(core.current_config_id(), ARRAY['moderation_safety_net_hours'], 48)::int AS hours),
  waiting AS (SELECT s.submitted_at FROM core.listing_submission s WHERE s.state = 'NEEDS_REVIEW')
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
  v_count   bigint := (v_over ->> 'count')::bigint;
  v_today   timestamptz := date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_audited boolean := false;
BEGIN
  PERFORM ledger.require_read_committed();
  IF v_count > 0 THEN
    -- one row per UTC day, whatever the number of runs: concurrent runs take turns here
    PERFORM core.lock_actor('core.moderation_overdue', '00000000-0000-0000-0000-000000000000'::uuid);
    IF NOT EXISTS (SELECT 1 FROM audit.audit_log l
                    WHERE l.action = 'moderation.overdue' AND l.actor_kind = 'SYSTEM' AND l.created_at >= v_today) THEN
      PERFORM audit.append_chained(NULL, 'SYSTEM', 'moderation.overdue', 'moderation_queue', 'NEEDS_REVIEW',
        format('%s listing(s) have waited for review longer than %s hours', v_count, v_over ->> 'thresholdHours'),
        jsonb_build_object('count', v_count, 'oldestSubmittedAt', v_over -> 'oldestSubmittedAt',
                           'thresholdHours', v_over -> 'thresholdHours'));
      v_audited := true;
    END IF;
  END IF;
  RETURN jsonb_build_object('overdue', v_count > 0, 'count', v_count,
                            'oldestAgeSeconds', v_over -> 'oldestAgeSeconds', 'audited', v_audited);
END $$;

-- ---------------------------------------------------------------- Super Admin decisions while paused
CREATE OR REPLACE FUNCTION core.admin_listing_decide(p_product uuid, p_version uuid, p_decision text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_actor   uuid := core.admin_actor();
  v_reason  text := core.admin_reason(p_reason);
  v_p       core.product;
  v_s       core.listing_submission;
  v_outcome text;
BEGIN
  PERFORM ledger.require_read_committed();
  IF p_decision IS NULL OR p_decision NOT IN ('APPROVE', 'REJECT') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'decision is APPROVE or REJECT');
  END IF;
  v_p := core.admin_listing_locked(p_product);
  SELECT * INTO v_s FROM core.listing_submission s WHERE s.product_id = v_p.id AND s.state = 'NEEDS_REVIEW';
  IF v_s.id IS NULL OR v_s.version_id IS DISTINCT FROM p_version THEN
    PERFORM core.fail('CONFLICT', 'that revision is not waiting for review');
  END IF;
  IF p_decision = 'APPROVE' THEN
    v_outcome := core.listing_approve(v_s.id, 'SUPER_ADMIN', v_reason);
  ELSE
    PERFORM core.listing_reject(v_s.id, NULL, 'SUPER_ADMIN', v_reason);
    v_outcome := 'REJECTED';
  END IF;
  PERFORM core.admin_audit(v_actor, CASE p_decision WHEN 'APPROVE' THEN 'listing.approve' ELSE 'listing.reject' END,
                           'product', v_p.id::text, v_reason,
                           jsonb_build_object('versionId', p_version, 'kind', v_s.kind, 'outcome', v_outcome,
                                              'publicationSwitch', core.switch_on('publication')));
  PERFORM core.listing_checks();
  RETURN jsonb_build_object('outcome', v_outcome, 'productId', v_p.id, 'versionId', p_version);
END $$;

CREATE OR REPLACE FUNCTION core.admin_listing_restore(p_product uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_actor  uuid := core.admin_actor();
  v_reason text := core.admin_reason(p_reason);
  v_p      core.product;
BEGIN
  PERFORM ledger.require_read_committed();
  v_p := core.admin_listing_locked(p_product);
  IF v_p.status <> 'HIDDEN' THEN
    PERFORM core.fail('CONFLICT', 'only a hidden listing is restored');
  END IF;
  UPDATE core.product p SET status = 'PUBLISHED', moderation_reason = NULL, updated_at = clock_timestamp()
   WHERE p.id = v_p.id;
  INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
  VALUES (core.uuid_v7(), 'listing_restored', v_p.id, jsonb_build_object('productId', v_p.id, 'companyId', v_p.company_id), 1);
  PERFORM core.admin_audit(v_actor, 'listing.restore', 'product', v_p.id::text, v_reason, '{}'::jsonb);
  PERFORM core.listing_checks();
  RETURN jsonb_build_object('outcome', 'PUBLISHED', 'productId', v_p.id);
END $$;

-- ---------------------------------------------------------------- the console's status
CREATE FUNCTION core.admin_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := core.admin_actor();   -- FORBIDDEN for anyone else, before anything is read
  v_sw    core.system_switch;
BEGIN
  SELECT * INTO v_sw FROM core.system_switch sw WHERE sw.name = 'publication';
  RETURN jsonb_build_object(
    'publication', jsonb_build_object('enabled', COALESCE(v_sw.enabled, false), 'updatedAt', v_sw.updated_at),
    'moderationOverdue', core.moderation_overdue(),
    'needsReview', (SELECT count(*) FROM core.listing_submission s WHERE s.state = 'NEEDS_REVIEW'),
    'openReportCases', (SELECT count(*) FROM core.report_case rc WHERE rc.status = 'OPEN'),
    'openAppeals', (SELECT count(*) FROM core.appeal a WHERE a.status = 'OPEN'));
END $$;

REVOKE ALL ON FUNCTION core.moderation_overdue(), core.admin_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_status() TO app_web;
