-- Player listings, part 3: Super Admin moderation, the publication switch and the moderation
-- safety net (LLD §6 product listing, §9 moderation.safety_net, §11.4 audit chain).
--
-- The single operator is the user_profile with role SUPER_ADMIN (one at most, 0002), assigned only
-- by the database owner (scripts/dev-setup.ts does it locally for SUPER_ADMIN_EMAIL). The admin
-- functions are executable by app_web; each one first derives the actor from the sign-in session
-- and refuses (FORBIDDEN) anyone who is not the Super Admin, before reading anything: the answer
-- is the same whether or not the target exists, and nothing is written. Every admin action needs
-- a reason (5-500 characters, no control characters, nothing that looks like an email address,
-- phone number or link: the reason is shown to the store owner and kept in the audit log) and
-- appends one row to the audit hash chain (audit.append_chained, 0030) in the same transaction.
--
--  * core.admin_moderation_queue(cursor, page_size): NEEDS_REVIEW submissions, oldest first, with
--    the submitted text and the screening reasons. Hidden listings with open appeals belong after
--    them, but appeals do not exist yet (`appeals` is always empty).
--  * core.admin_listing_decide(product, version, 'APPROVE' | 'REJECT', reason): the version must
--    be the one waiting for review. APPROVE publishes (or records the approval when the starter
--    warehouse lacks the room) or makes a revision live; refused while publication is paused.
--  * core.admin_listing_hide(product, reason): PUBLISHED -> HIDDEN at once (gone from every public
--    read); buyers keep what they own. core.admin_listing_restore(product, reason): HIDDEN ->
--    PUBLISHED (refused while publication is paused).
--  * core.admin_set_switch(name, enabled, reason): any existing system switch.
--  * core.moderation_safety_net() (app_jobs only): when the oldest submission waiting for
--    screening or review is older than `moderation_safety_net_hours` (48), switches publication off
--    and writes a SYSTEM audit row; it does not switch it off again once the Super Admin switched
--    it back on after that submission became overdue. Idempotent.

-- ---------------------------------------------------------------- helpers
-- The signed-in Super Admin, or FORBIDDEN.
CREATE FUNCTION core.admin_actor() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := core.actor_id();
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM core.user_profile up
                                     WHERE up.id = v_actor AND up.role = 'SUPER_ADMIN' AND up.status = 'ACTIVE') THEN
    PERFORM core.fail('FORBIDDEN', 'this needs the Super Admin');
  END IF;
  RETURN v_actor;
END $$;

-- A moderation reason, trimmed; VALIDATION_FAILED when it breaks the rules above.
CREATE FUNCTION core.admin_reason(p_reason text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_reason text := btrim(COALESCE(p_reason, ''));
BEGIN
  IF char_length(v_reason) NOT BETWEEN 5 AND 500 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'a reason is 5 to 500 characters');
  END IF;
  IF v_reason ~ '[[:cntrl:]]' THEN
    PERFORM core.fail('VALIDATION_FAILED', 'a reason may not contain control characters');
  END IF;
  IF v_reason ~ '@' OR v_reason ~* '(https?://|www\.)'
     OR EXISTS (SELECT 1 FROM regexp_matches(v_reason, '([0-9][0-9 ().+/-]*)', 'g') m
                 WHERE char_length(regexp_replace(m[1], '[^0-9]', '', 'g')) >= 10) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'a reason may not contain contact details or links');
  END IF;
  RETURN v_reason;
END $$;

CREATE FUNCTION core.admin_audit(p_actor uuid, p_action text, p_target_type text, p_target text, p_reason text,
                                 p_detail jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM audit.append_chained(p_actor, 'SUPER_ADMIN', p_action, p_target_type, p_target, p_reason, p_detail);
END $$;

-- Locks a USER product's company, warehouses and product (LLD §4) and returns it; NOT_FOUND.
CREATE FUNCTION core.admin_listing_locked(p_product uuid) RETURNS core.product
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_company uuid;
  v_p core.product;
BEGIN
  SELECT p.company_id INTO v_company FROM core.product p WHERE p.id = p_product AND p.seller_type = 'USER';
  IF v_company IS NULL THEN
    PERFORM core.fail('NOT_FOUND', 'product not found');
  END IF;
  PERFORM core.listing_lock(v_company, p_product);
  SELECT * INTO v_p FROM core.product p WHERE p.id = p_product;
  RETURN v_p;
END $$;

-- ---------------------------------------------------------------- the queue
CREATE FUNCTION core.admin_moderation_queue(p_cursor uuid, p_page_size int) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := core.admin_actor();
  v_size  int := core.page_size(p_page_size);
  v_items jsonb;
  v_ids   uuid[];
BEGIN
  SELECT COALESCE(jsonb_agg(x.j ORDER BY x.submitted_at, x.id), '[]'::jsonb), array_agg(x.id ORDER BY x.submitted_at, x.id)
    INTO v_items, v_ids
    FROM (SELECT s.id, s.submitted_at, jsonb_build_object(
                   'submissionId', s.id, 'productId', s.product_id, 'versionId', s.version_id, 'kind', s.kind,
                   'submittedAt', s.submitted_at, 'reasons', s.reasons,
                   'store', jsonb_build_object('handle', c.handle, 'displayName', c.name),
                   'category', p.category, 'inventoryMode', p.inventory_mode, 'productStatus', p.status,
                   'version', core.listing_version_json(v)) AS j
            FROM core.listing_submission s
            JOIN core.product p ON p.id = s.product_id
            JOIN core.company c ON c.id = s.company_id
            JOIN core.product_version v ON v.id = s.version_id
           WHERE s.state = 'NEEDS_REVIEW'
             AND (p_cursor IS NULL OR (s.submitted_at, s.id) > (SELECT o.submitted_at, o.id FROM core.listing_submission o
                                                                  WHERE o.id = p_cursor))
           ORDER BY s.submitted_at, s.id LIMIT v_size) x;
  RETURN jsonb_build_object('items', v_items,
    'nextCursor', CASE WHEN cardinality(v_ids) = v_size THEN v_ids[v_size] END,
    -- hidden listings with open appeals come after the reviews; appeals are not built yet
    'appeals', '[]'::jsonb);
END $$;

-- ---------------------------------------------------------------- decisions
CREATE FUNCTION core.admin_listing_decide(p_product uuid, p_version uuid, p_decision text, p_reason text) RETURNS jsonb
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
  IF p_decision = 'APPROVE' AND NOT core.switch_on('publication') THEN
    PERFORM core.fail('PUBLICATION_PAUSED', 'publication is paused; switch it on first');
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
                           jsonb_build_object('versionId', p_version, 'kind', v_s.kind, 'outcome', v_outcome));
  PERFORM core.listing_checks();
  RETURN jsonb_build_object('outcome', v_outcome, 'productId', v_p.id, 'versionId', p_version);
END $$;

CREATE FUNCTION core.admin_listing_hide(p_product uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_actor  uuid := core.admin_actor();
  v_reason text := core.admin_reason(p_reason);
  v_p      core.product;
BEGIN
  PERFORM ledger.require_read_committed();
  v_p := core.admin_listing_locked(p_product);
  IF v_p.status <> 'PUBLISHED' THEN
    PERFORM core.fail('CONFLICT', 'only a published listing is hidden');
  END IF;
  UPDATE core.product p SET status = 'HIDDEN', moderation_reason = v_reason, updated_at = clock_timestamp()
   WHERE p.id = v_p.id;
  INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
  VALUES (core.uuid_v7(), 'listing_hidden', v_p.id, jsonb_build_object('productId', v_p.id, 'companyId', v_p.company_id), 1);
  PERFORM core.admin_audit(v_actor, 'listing.hide', 'product', v_p.id::text, v_reason, '{}'::jsonb);
  PERFORM core.listing_checks();
  RETURN jsonb_build_object('outcome', 'HIDDEN', 'productId', v_p.id);
END $$;

CREATE FUNCTION core.admin_listing_restore(p_product uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_actor  uuid := core.admin_actor();
  v_reason text := core.admin_reason(p_reason);
  v_p      core.product;
BEGIN
  PERFORM ledger.require_read_committed();
  IF NOT core.switch_on('publication') THEN
    PERFORM core.fail('PUBLICATION_PAUSED', 'publication is paused; switch it on first');
  END IF;
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

CREATE FUNCTION core.admin_set_switch(p_name text, p_enabled boolean, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_actor  uuid := core.admin_actor();
  v_reason text := core.admin_reason(p_reason);
  v_sw     core.system_switch;
BEGIN
  PERFORM ledger.require_read_committed();
  IF p_enabled IS NULL THEN
    PERFORM core.fail('VALIDATION_FAILED', 'enabled is true or false');
  END IF;
  SELECT * INTO v_sw FROM core.system_switch sw WHERE sw.name = p_name FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM core.fail('NOT_FOUND', 'switch not found');
  END IF;
  UPDATE core.system_switch sw SET enabled = p_enabled, updated_at = clock_timestamp() WHERE sw.name = p_name;
  PERFORM core.admin_audit(v_actor, 'switch.set', 'system_switch', p_name, v_reason,
                           jsonb_build_object('enabled', p_enabled, 'previous', v_sw.enabled));
  RETURN jsonb_build_object('name', p_name, 'enabled', p_enabled);
END $$;

-- ---------------------------------------------------------------- the safety net (app_jobs)
CREATE FUNCTION core.moderation_safety_net() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_hours  bigint := core.config_int(core.current_config_id(), ARRAY['moderation_safety_net_hours'], 48);
  v_limit  interval := make_interval(hours => v_hours::int);
  v_oldest timestamptz;
  v_sw     core.system_switch;
BEGIN
  PERFORM ledger.require_read_committed();
  SELECT min(s.submitted_at) INTO v_oldest FROM core.listing_submission s WHERE s.state IN ('SCREENING', 'NEEDS_REVIEW');
  IF v_oldest IS NULL OR v_oldest > clock_timestamp() - v_limit THEN
    RETURN jsonb_build_object('paused', false);
  END IF;
  SELECT * INTO v_sw FROM core.system_switch sw WHERE sw.name = 'publication' FOR UPDATE;
  -- already off, or switched back on by the Super Admin after this submission became overdue
  IF NOT FOUND OR NOT v_sw.enabled OR v_sw.updated_at >= v_oldest + v_limit THEN
    RETURN jsonb_build_object('paused', false);
  END IF;
  UPDATE core.system_switch sw SET enabled = false, updated_at = clock_timestamp() WHERE sw.name = 'publication';
  PERFORM audit.append_chained(NULL, 'SYSTEM', 'moderation.safety_net', 'system_switch', 'publication',
    format('the oldest listing waiting for screening or review is older than %s hours', v_hours),
    jsonb_build_object('oldestSubmittedAt', v_oldest, 'hours', v_hours));
  RETURN jsonb_build_object('paused', true);
END $$;

-- ---------------------------------------------------------------- privileges
REVOKE ALL ON FUNCTION core.admin_actor(), core.admin_reason(text),
  core.admin_audit(uuid, text, text, text, text, jsonb), core.admin_listing_locked(uuid),
  core.admin_moderation_queue(uuid, int), core.admin_listing_decide(uuid, uuid, text, text),
  core.admin_listing_hide(uuid, text), core.admin_listing_restore(uuid, text),
  core.admin_set_switch(text, boolean, text), core.moderation_safety_net()
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_moderation_queue(uuid, int), core.admin_listing_decide(uuid, uuid, text, text),
  core.admin_listing_hide(uuid, text), core.admin_listing_restore(uuid, text),
  core.admin_set_switch(text, boolean, text)
TO app_web;
GRANT EXECUTE ON FUNCTION core.moderation_safety_net() TO app_jobs;
