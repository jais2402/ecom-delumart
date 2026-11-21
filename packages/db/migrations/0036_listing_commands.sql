-- Player listings, part 2: the studio, submission, screening, publication and stock commands
-- (US-08, US-29). Every command is a SECURITY DEFINER function owned by the migration role, with a
-- pinned search_path and schema-qualified references, no dynamic SQL. The owner commands
-- (EXECUTE for app_web):
--   * derive the actor from the sign-in session and serialise that actor's studio calls on
--     core.lock_actor('core.studio', actor);
--   * need creator access (CREATOR_LOCKED) and the actor's registered company
--     (COMPANY_FEE_REQUIRED); a product of another company is NOT_FOUND, exactly as one that does
--     not exist, so user A never reads or changes user B's listings;
--   * take the canonical locks (LLD §4): the company (#4), its warehouses in ascending id (#5), the
--     product (#6), units (#7), each FOR NO KEY UPDATE under a 2 s lock_timeout;
--   * validate synchronously and fire every deferred structural check (0016, 0019, 0035) before
--     returning.
-- The screening job (EXECUTE for app_jobs only) reads the pending revisions with
-- core.screening_pending and applies its verdict with core.screening_apply, which re-checks that
-- the version is still the pinned one. A product whose screening never comes back stays in
-- SCREENING: nothing here approves anything by default.
--
-- Tunables (configuration, with these defaults): listing_drafts_max (20), listing_published_max
-- (10), listing_submissions_per_day (10), listing_quantity_max (1000), price_min_paise /
-- price_max_paise (0013).
--
-- What the database takes on the server's word: nothing about the listing text. Lengths, formats,
-- the category, price and quantity rules are checked here; the TEXT SCREENING is not done by the
-- web server at all but by the job, whose verdict this database accepts from app_jobs (the jobs
-- credential) only.

-- ---------------------------------------------------------------- rules
-- What is wrong with a listing's text, as [code, message]; NULL when nothing.
CREATE FUNCTION core.listing_text_problem(p_name text, p_hook text, p_description text, p_alt_text text,
                                          p_template_id int) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 3 AND 80 THEN
    RETURN ARRAY['VALIDATION_FAILED', 'a name is 3 to 80 characters'];
  END IF;
  IF p_hook IS NOT NULL AND char_length(p_hook) > 140 THEN
    RETURN ARRAY['VALIDATION_FAILED', 'a hook is at most 140 characters'];
  END IF;
  IF p_description IS NULL OR char_length(btrim(p_description)) NOT BETWEEN 20 AND 1000 THEN
    RETURN ARRAY['VALIDATION_FAILED', 'a description is 20 to 1,000 characters'];
  END IF;
  IF p_alt_text IS NULL OR char_length(p_alt_text) > 300 THEN
    RETURN ARRAY['VALIDATION_FAILED', 'alt text is at most 300 characters'];
  END IF;
  IF p_name ~ '[[:cntrl:]]' OR COALESCE(p_hook, '') ~ '[[:cntrl:]]' OR p_alt_text ~ '[[:cntrl:]]'
     OR p_description ~ '[\x01-\x09\x0b-\x1f\x7f]' THEN
    RETURN ARRAY['VALIDATION_FAILED', 'listing text may not contain control characters'];
  END IF;
  IF p_template_id IS NULL OR p_template_id NOT BETWEEN 0 AND 359 THEN
    RETURN ARRAY['VALIDATION_FAILED', 'the illustration is a template from 0 to 359'];
  END IF;
  RETURN NULL;
END $$;

-- Whole rupees within the configured price range.
CREATE FUNCTION core.listing_price_problem(p_price bigint) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cfg int := core.current_config_id();
BEGIN
  IF p_price IS NULL OR p_price % 100 <> 0
     OR p_price < core.config_paise(cfg, ARRAY['price_min_paise'], 10000)
     OR p_price > core.config_paise(cfg, ARRAY['price_max_paise'], 100000000000) THEN
    RETURN ARRAY['VALIDATION_FAILED', 'a price is whole rupees from ₹100 to ₹100 crore'];
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION core.listing_quantity_problem(p_quantity int) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN p_quantity IS NULL OR p_quantity < 1
                   OR p_quantity > core.config_int(core.current_config_id(), ARRAY['listing_quantity_max'], 1000)
              THEN ARRAY['VALIDATION_FAILED', 'a quantity is at least 1 and at most the configured maximum'] END
$$;

-- ---------------------------------------------------------------- the studio actor and locks
-- The signed-in owner's company, holding the actor's studio lock.
CREATE FUNCTION core.listing_studio() RETURNS core.company
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := core.require_actor();
  v_company core.company;
BEGIN
  PERFORM ledger.require_read_committed();
  PERFORM core.lock_actor('core.studio', v_actor);
  IF NOT EXISTS (SELECT 1 FROM core.creator_entitlement ce WHERE ce.user_id = v_actor) THEN
    PERFORM core.fail('CREATOR_LOCKED', 'unlock creator access first');
  END IF;
  SELECT * INTO v_company FROM core.company c WHERE c.owner_user_id = v_actor;
  IF NOT FOUND THEN
    PERFORM core.fail('COMPANY_FEE_REQUIRED', 'register a company first');
  END IF;
  RETURN v_company;
END $$;

-- LLD §4: the company (#4), its warehouses in ascending id (#5), then the product (#6).
CREATE FUNCTION core.listing_lock(p_company uuid, p_product uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM core.company c WHERE c.id = p_company FOR NO KEY UPDATE;
  PERFORM 1 FROM core.warehouse w WHERE w.company_id = p_company ORDER BY w.id FOR NO KEY UPDATE;
  IF p_product IS NOT NULL THEN
    PERFORM 1 FROM core.product p WHERE p.id = p_product FOR NO KEY UPDATE;
  END IF;
END $$;

-- The actor's own product (after the locks), or NOT_FOUND: another company's product is
-- indistinguishable from one that does not exist.
CREATE FUNCTION core.listing_own(p_company uuid, p_product uuid) RETURNS core.product
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_p core.product;
BEGIN
  SELECT * INTO v_p FROM core.product p WHERE p.id = p_product AND p.company_id = p_company AND p.seller_type = 'USER';
  IF NOT FOUND THEN
    PERFORM core.fail('NOT_FOUND', 'product not found');
  END IF;
  RETURN v_p;
END $$;

-- Locks and returns the actor's own product (NOT_FOUND before any lock when it is not theirs).
CREATE FUNCTION core.listing_own_locked(p_company uuid, p_product uuid) RETURNS core.product
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM core.listing_own(p_company, p_product);
  PERFORM core.listing_lock(p_company, p_product);
  RETURN core.listing_own(p_company, p_product);
END $$;

-- ---------------------------------------------------------------- counts
-- Private listings (drafts and those in screening, review or rejected).
CREATE FUNCTION core.listing_private_count(p_company uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT count(*) FROM core.product p
   WHERE p.company_id = p_company AND p.status IN ('DRAFT', 'SCREENING', 'NEEDS_REVIEW', 'REJECTED')
$$;

-- Live listings: published, or hidden by moderation (a hidden listing can be restored).
CREATE FUNCTION core.listing_live_count(p_company uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT count(*) FROM core.product p WHERE p.company_id = p_company AND p.status IN ('PUBLISHED', 'HIDDEN')
$$;

-- First publications on their way: in screening or review, or approved and waiting for stock.
CREATE FUNCTION core.listing_incoming_count(p_company uuid, p_except uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT count(*) FROM core.product p
   WHERE p.company_id = p_company AND p.published_at IS NULL AND p.id IS DISTINCT FROM p_except
     AND (p.status IN ('SCREENING', 'NEEDS_REVIEW') OR p.approved_needs_stock)
$$;

CREATE FUNCTION core.listing_submissions_today(p_company uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT count(*) FROM core.listing_submission s
   WHERE s.company_id = p_company
     AND s.submitted_at >= (date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
$$;

CREATE FUNCTION core.listing_cap(p_key text, p_default bigint) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT core.config_int(core.current_config_id(), ARRAY[p_key], p_default)
$$;

-- ---------------------------------------------------------------- versions
CREATE FUNCTION core.listing_new_version(p_product uuid, p_name text, p_hook text, p_description text,
                                         p_alt_text text, p_template_id int, p_price bigint, p_author uuid)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_id uuid := core.uuid_v7();
BEGIN
  INSERT INTO core.product_version (id, product_id, revision, name, hook, description, alt_text, template_id,
                                    price_paise, author_user_id, search)
  VALUES (v_id, p_product,
          COALESCE((SELECT max(v.revision) FROM core.product_version v WHERE v.product_id = p_product), 0) + 1,
          p_name, p_hook, p_description, p_alt_text, p_template_id, p_price, p_author,
          to_tsvector('simple', p_name || ' ' || COALESCE(p_hook, '') || ' ' || p_description));
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------- the owner's view
CREATE FUNCTION core.listing_version_json(v core.product_version) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN v.id IS NULL THEN NULL ELSE jsonb_build_object(
    'versionId', v.id, 'revision', v.revision, 'name', v.name, 'hook', v.hook, 'description', v.description,
    'altText', v.alt_text, 'templateId', v.template_id, 'pricePaise', v.price_paise::text, 'createdAt', v.created_at) END
$$;

CREATE FUNCTION core.listing_json(p core.product) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH st AS (
    SELECT count(*) FILTER (WHERE u.state = 'AVAILABLE') AS available,
           count(*) FILTER (WHERE u.state IN ('ISSUED', 'REVOKED_ISSUED')) AS issued,
           count(*) FILTER (WHERE u.state = 'RETIRED_UNSOLD') AS retired
      FROM core.inventory_unit u WHERE u.product_id = p.id
  ), cur AS (
    SELECT core.listing_version_json(v) AS j FROM core.product_version v WHERE v.id = p.current_version_id
  ), pend AS (
    SELECT jsonb_build_object('submissionId', s.id, 'kind', s.kind, 'state', s.state, 'submittedAt', s.submitted_at,
                              'reasons', s.reasons, 'version', core.listing_version_json(v)) AS j
      FROM core.listing_submission s JOIN core.product_version v ON v.id = s.version_id
     WHERE s.product_id = p.id AND s.state IN ('SCREENING', 'NEEDS_REVIEW')
  ), dec AS (
    SELECT jsonb_build_object('kind', s.kind, 'state', s.state, 'versionId', s.version_id, 'reasons', s.reasons,
                              'reason', s.decision_reason, 'decidedBy', s.decided_by, 'decidedAt', s.decided_at) AS j
      FROM core.listing_submission s
     WHERE s.product_id = p.id AND s.state IN ('APPROVED', 'REJECTED')
     ORDER BY s.decided_at DESC NULLS LAST, s.id DESC LIMIT 1
  )
  SELECT jsonb_build_object(
    'productId', p.id,
    'status', p.status,
    'category', p.category,
    'inventoryMode', p.inventory_mode,
    'quantity', CASE WHEN p.inventory_mode = 'EXCLUSIVE' THEN p.exclusive_supply ELSE p.planned_quantity END,
    'offersExpress', p.offers_express,
    'freeStandardDelivery', p.free_standard_delivery,
    'approvedNeedsStock', p.approved_needs_stock,
    'createdAt', p.created_at,
    'updatedAt', p.updated_at,
    'publishedAt', p.published_at,
    'current', (SELECT j FROM cur),
    'live', CASE WHEN p.published_at IS NOT NULL THEN (SELECT j FROM cur) END,
    'pending', (SELECT j FROM pend),
    'lastDecision', (SELECT j FROM dec),
    'moderationReason', p.moderation_reason,
    'stock', (SELECT jsonb_build_object('available', st.available, 'issued', st.issued, 'retired', st.retired) FROM st),
    'edition', (SELECT jsonb_build_object('supply', e.supply, 'issued', st.issued) FROM core.exclusive_edition e, st
                 WHERE e.product_id = p.id),
    'nextAction', CASE
       WHEN p.status = 'DRAFT' AND p.approved_needs_stock THEN 'ALLOCATE_STOCK'
       WHEN p.status = 'DRAFT' THEN 'SUBMIT'
       WHEN p.status = 'SCREENING' THEN 'WAIT_FOR_SCREENING'
       WHEN p.status = 'NEEDS_REVIEW' THEN 'WAIT_FOR_REVIEW'
       WHEN p.status = 'REJECTED' THEN 'EDIT_AND_RESUBMIT'
       WHEN p.status = 'HIDDEN' THEN 'HIDDEN_BY_MODERATION'
       WHEN p.status = 'PUBLISHED' AND (SELECT j FROM pend) IS NOT NULL THEN 'WAIT_FOR_REVISION'
       WHEN p.status = 'PUBLISHED' AND p.inventory_mode = 'STANDARD_STOCKED' AND (SELECT available FROM st) = 0 THEN 'RESTOCK'
       ELSE 'NONE' END)
$$;

-- The owner's listings, newest first: {items, nextCursor}. p_status filters by one status.
CREATE FUNCTION core.my_products(p_status text, p_cursor uuid, p_page_size int) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := core.require_actor();
  v_size  int := core.page_size(p_page_size);
  v_items jsonb;
  v_ids   uuid[];
BEGIN
  IF p_status IS NOT NULL AND p_status NOT IN ('DRAFT', 'SCREENING', 'NEEDS_REVIEW', 'PUBLISHED', 'REJECTED', 'HIDDEN', 'ARCHIVED') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'unknown status');
  END IF;
  SELECT COALESCE(jsonb_agg(core.listing_json(x) ORDER BY x.id DESC), '[]'::jsonb), array_agg(x.id ORDER BY x.id DESC)
    INTO v_items, v_ids
    FROM (SELECT p.* FROM core.product p JOIN core.company c ON c.id = p.company_id
           WHERE c.owner_user_id = v_actor AND p.seller_type = 'USER'
             AND (p_status IS NULL OR p.status = p_status)
             AND (p_cursor IS NULL OR p.id < p_cursor)
           ORDER BY p.id DESC LIMIT v_size) x;
  RETURN jsonb_build_object('items', v_items,
    'nextCursor', CASE WHEN cardinality(v_ids) = v_size THEN v_ids[v_size] END);
END $$;

-- One own listing with every revision and its price history; NOT_FOUND for anyone else's.
CREATE FUNCTION core.my_product(p_product uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := core.require_actor();
  v_p     core.product;
BEGIN
  SELECT p.* INTO v_p FROM core.product p JOIN core.company c ON c.id = p.company_id
   WHERE p.id = p_product AND c.owner_user_id = v_actor AND p.seller_type = 'USER';
  IF NOT FOUND THEN
    PERFORM core.fail('NOT_FOUND', 'product not found');
  END IF;
  RETURN core.listing_json(v_p) || jsonb_build_object(
    'versions', (SELECT COALESCE(jsonb_agg(core.listing_version_json(v) || jsonb_build_object(
                    'isCurrent', v.id = v_p.current_version_id,
                    'submissions', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                                       'kind', s.kind, 'state', s.state, 'reasons', s.reasons,
                                       'reason', s.decision_reason, 'decidedBy', s.decided_by,
                                       'submittedAt', s.submitted_at, 'decidedAt', s.decided_at) ORDER BY s.id), '[]'::jsonb)
                                      FROM core.listing_submission s WHERE s.version_id = v.id))
                  ORDER BY v.revision DESC), '[]'::jsonb)
                  FROM core.product_version v WHERE v.product_id = v_p.id),
    'priceHistory', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                        'versionId', h.version_id, 'pricePaise', h.price_paise::text,
                        'previousPaise', h.previous_paise::text, 'reason', h.reason, 'changedAt', h.changed_at)
                      ORDER BY h.id DESC), '[]'::jsonb)
                       FROM core.price_history h WHERE h.product_id = v_p.id));
END $$;

CREATE FUNCTION core.listing_result(p_product uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('product', core.my_product(p_product))
$$;

-- Fires every deferred structural check now (the commands' last step).
CREATE FUNCTION core.listing_checks() RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
END $$;

-- ---------------------------------------------------------------- drafts
CREATE FUNCTION core.draft_create(p_name text, p_hook text, p_description text, p_category text, p_template_id int,
                                  p_alt_text text, p_price_paise bigint, p_mode text, p_quantity int,
                                  p_offers_express boolean, p_free_standard_delivery boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_company core.company := core.listing_studio();
  v_name    text := btrim(p_name);
  v_hook    text := NULLIF(btrim(COALESCE(p_hook, '')), '');
  v_desc    text := btrim(p_description);
  v_alt     text := btrim(COALESCE(p_alt_text, ''));
  v_problem text[];
  v_id      uuid := core.uuid_v7();
  v_version uuid;
BEGIN
  v_problem := COALESCE(core.listing_text_problem(v_name, v_hook, v_desc, v_alt, p_template_id),
                        core.listing_price_problem(p_price_paise), core.listing_quantity_problem(p_quantity));
  IF v_problem IS NOT NULL THEN PERFORM core.fail(v_problem[1], v_problem[2]); END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('STANDARD_STOCKED', 'EXCLUSIVE') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'inventory mode is STANDARD_STOCKED or EXCLUSIVE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.category cat WHERE cat.slug = p_category) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'unknown category');
  END IF;
  -- #4 the company: the draft cap is counted under its lock
  PERFORM 1 FROM core.company c WHERE c.id = v_company.id FOR NO KEY UPDATE;
  IF core.listing_private_count(v_company.id) >= core.listing_cap('listing_drafts_max', 20) THEN
    PERFORM core.fail('DRAFT_LIMIT', 'your studio already holds the most private drafts it may');
  END IF;
  INSERT INTO core.product (id, company_id, seller_type, status, category, inventory_mode, exclusive_supply,
                            planned_quantity, offers_express, free_standard_delivery, created_at)
  VALUES (v_id, v_company.id, 'USER', 'DRAFT', p_category, p_mode,
          CASE WHEN p_mode = 'EXCLUSIVE' THEN p_quantity END,
          CASE WHEN p_mode = 'STANDARD_STOCKED' THEN p_quantity END,
          COALESCE(p_offers_express, false), COALESCE(p_free_standard_delivery, false), clock_timestamp());
  v_version := core.listing_new_version(v_id, v_name, v_hook, v_desc, v_alt, p_template_id, p_price_paise,
                                        v_company.owner_user_id);
  UPDATE core.product p SET current_version_id = v_version WHERE p.id = v_id;
  PERFORM core.listing_checks();
  RETURN core.listing_result(v_id);
END $$;

-- Edits a draft (NULL leaves a field unchanged; an empty hook clears it): a new revision the draft
-- points at. Allowed while DRAFT or REJECTED, and while NEEDS_REVIEW, which withdraws the review
-- and returns the listing to DRAFT. An approval waiting for stock is void after an edit.
CREATE FUNCTION core.draft_update(p_product uuid, p_name text, p_hook text, p_description text, p_category text,
                                  p_template_id int, p_alt_text text, p_price_paise bigint, p_mode text,
                                  p_quantity int, p_offers_express boolean, p_free_standard_delivery boolean)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_company core.company := core.listing_studio();
  v_p       core.product := core.listing_own_locked(v_company.id, p_product);
  v_cur     core.product_version;
  v_name    text;
  v_hook    text;
  v_desc    text;
  v_alt     text;
  v_tpl     int;
  v_price   bigint;
  v_cat     text;
  v_mode    text;
  v_qty     int;
  v_problem text[];
  v_version uuid;
BEGIN
  IF v_p.published_at IS NOT NULL OR v_p.status NOT IN ('DRAFT', 'REJECTED', 'NEEDS_REVIEW') THEN
    PERFORM core.fail('NOT_EDITABLE', 'only an unpublished draft is edited here (revise a live listing instead)');
  END IF;
  SELECT * INTO v_cur FROM core.product_version v WHERE v.id = v_p.current_version_id;
  v_name := COALESCE(btrim(p_name), v_cur.name);
  v_hook := CASE WHEN p_hook IS NULL THEN v_cur.hook ELSE NULLIF(btrim(p_hook), '') END;
  v_desc := COALESCE(btrim(p_description), v_cur.description);
  v_alt  := COALESCE(btrim(p_alt_text), v_cur.alt_text);
  v_tpl  := COALESCE(p_template_id, v_cur.template_id);
  v_price := COALESCE(p_price_paise, v_cur.price_paise);
  v_cat  := COALESCE(p_category, v_p.category);
  v_mode := COALESCE(p_mode, v_p.inventory_mode);
  v_qty  := COALESCE(p_quantity, CASE WHEN v_mode = 'EXCLUSIVE' THEN v_p.exclusive_supply ELSE v_p.planned_quantity END,
                     v_p.exclusive_supply, v_p.planned_quantity);
  v_problem := COALESCE(core.listing_text_problem(v_name, v_hook, v_desc, v_alt, v_tpl),
                        core.listing_price_problem(v_price), core.listing_quantity_problem(v_qty));
  IF v_problem IS NOT NULL THEN PERFORM core.fail(v_problem[1], v_problem[2]); END IF;
  IF v_mode NOT IN ('STANDARD_STOCKED', 'EXCLUSIVE') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'inventory mode is STANDARD_STOCKED or EXCLUSIVE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.category cat WHERE cat.slug = v_cat) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'unknown category');
  END IF;
  UPDATE core.listing_submission s SET state = 'WITHDRAWN', decided_by = 'OWNER', decided_at = clock_timestamp()
   WHERE s.product_id = v_p.id AND s.state IN ('SCREENING', 'NEEDS_REVIEW');
  v_version := core.listing_new_version(v_p.id, v_name, v_hook, v_desc, v_alt, v_tpl, v_price, v_company.owner_user_id);
  UPDATE core.product p
     SET status = 'DRAFT', current_version_id = v_version, pending_version_id = NULL, approved_needs_stock = false,
         category = v_cat, inventory_mode = v_mode,
         exclusive_supply = CASE WHEN v_mode = 'EXCLUSIVE' THEN v_qty END,
         planned_quantity = CASE WHEN v_mode = 'STANDARD_STOCKED' THEN v_qty END,
         offers_express = COALESCE(p_offers_express, p.offers_express),
         free_standard_delivery = COALESCE(p_free_standard_delivery, p.free_standard_delivery),
         updated_at = clock_timestamp()
   WHERE p.id = v_p.id;
  PERFORM core.listing_checks();
  RETURN core.listing_result(v_p.id);
END $$;

-- Deletes a draft that was never published (not while it is being screened).
CREATE FUNCTION core.draft_delete(p_product uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_company core.company := core.listing_studio();
  v_p       core.product := core.listing_own_locked(v_company.id, p_product);
BEGIN
  IF v_p.published_at IS NOT NULL OR v_p.status NOT IN ('DRAFT', 'REJECTED', 'NEEDS_REVIEW') THEN
    PERFORM core.fail('NOT_EDITABLE', 'only a draft that was never published is deleted (archive a live listing)');
  END IF;
  DELETE FROM core.listing_submission s WHERE s.product_id = v_p.id;
  UPDATE core.product p SET current_version_id = NULL, pending_version_id = NULL WHERE p.id = v_p.id;
  DELETE FROM core.product_version v WHERE v.product_id = v_p.id;
  DELETE FROM core.product p WHERE p.id = v_p.id;
  PERFORM core.listing_checks();
  RETURN jsonb_build_object('deleted', true, 'productId', v_p.id);
END $$;

-- ---------------------------------------------------------------- submission
CREATE FUNCTION core.listing_open_submission(p_product uuid, p_version uuid, p_company uuid, p_kind text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_id uuid := core.uuid_v7();
BEGIN
  IF core.listing_submissions_today(p_company) >= core.listing_cap('listing_submissions_per_day', 10) THEN
    PERFORM core.fail('SUBMISSION_LIMIT', 'your store has made its submissions for today (UTC); try again tomorrow');
  END IF;
  INSERT INTO core.listing_submission (id, product_id, version_id, company_id, kind, state)
  VALUES (v_id, p_product, p_version, p_company, p_kind, 'SCREENING');
  -- ids only (invariant 8)
  INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
  VALUES (core.uuid_v7(), 'listing_submitted', p_product, jsonb_build_object(
    'productId', p_product, 'versionId', p_version, 'submissionId', v_id, 'companyId', p_company, 'kind', p_kind), 1);
  RETURN v_id;
END $$;

-- DRAFT -> SCREENING, pinning the current revision (what screening judges and what is published).
CREATE FUNCTION core.product_submit(p_product uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_company core.company := core.listing_studio();
  v_p       core.product := core.listing_own_locked(v_company.id, p_product);
BEGIN
  IF v_p.published_at IS NOT NULL OR v_p.status <> 'DRAFT' THEN
    PERFORM core.fail('NOT_EDITABLE', 'only a draft is submitted (revise a live listing instead)');
  END IF;
  IF v_p.approved_needs_stock THEN
    PERFORM core.fail('CONFLICT', 'this listing is approved: allocate its stock to publish it');
  END IF;
  IF core.listing_live_count(v_company.id) + core.listing_incoming_count(v_company.id, v_p.id)
     >= core.listing_cap('listing_published_max', 10) THEN
    PERFORM core.fail('PUBLISH_LIMIT', 'your store has as many published listings as it may; archive one first');
  END IF;
  PERFORM core.listing_open_submission(v_p.id, v_p.current_version_id, v_company.id, 'FIRST');
  UPDATE core.product p
     SET status = 'SCREENING', pending_version_id = v_p.current_version_id, moderation_reason = NULL,
         updated_at = clock_timestamp()
   WHERE p.id = v_p.id;
  PERFORM core.listing_checks();
  RETURN core.listing_result(v_p.id);
END $$;

-- A new revision of a live listing's text, screened while the approved version stays live.
CREATE FUNCTION core.product_revise(p_product uuid, p_name text, p_hook text, p_description text, p_alt_text text,
                                    p_template_id int) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_company core.company := core.listing_studio();
  v_p       core.product := core.listing_own_locked(v_company.id, p_product);
  v_live    core.product_version;
  v_name    text;
  v_hook    text;
  v_desc    text;
  v_alt     text;
  v_tpl     int;
  v_problem text[];
  v_version uuid;
BEGIN
  IF v_p.status <> 'PUBLISHED' THEN
    PERFORM core.fail('NOT_EDITABLE', 'only a published listing is revised');
  END IF;
  SELECT * INTO v_live FROM core.product_version v WHERE v.id = v_p.current_version_id;
  v_name := COALESCE(btrim(p_name), v_live.name);
  v_hook := CASE WHEN p_hook IS NULL THEN v_live.hook ELSE NULLIF(btrim(p_hook), '') END;
  v_desc := COALESCE(btrim(p_description), v_live.description);
  v_alt  := COALESCE(btrim(p_alt_text), v_live.alt_text);
  v_tpl  := COALESCE(p_template_id, v_live.template_id);
  v_problem := core.listing_text_problem(v_name, v_hook, v_desc, v_alt, v_tpl);
  IF v_problem IS NOT NULL THEN PERFORM core.fail(v_problem[1], v_problem[2]); END IF;
  -- an open revision is replaced by this one
  UPDATE core.listing_submission s SET state = 'SUPERSEDED', decided_by = 'OWNER', decided_at = clock_timestamp()
   WHERE s.product_id = v_p.id AND s.state IN ('SCREENING', 'NEEDS_REVIEW');
  v_version := core.listing_new_version(v_p.id, v_name, v_hook, v_desc, v_alt, v_tpl, v_live.price_paise,
                                        v_company.owner_user_id);
  PERFORM core.listing_open_submission(v_p.id, v_version, v_company.id, 'REVISION');
  UPDATE core.product p SET pending_version_id = v_version, updated_at = clock_timestamp() WHERE p.id = v_p.id;
  PERFORM core.listing_checks();
  RETURN core.listing_result(v_p.id);
END $$;

-- ---------------------------------------------------------------- publication (callers hold the locks)
-- The first publication of an approved revision: allocates the stock in the starter warehouse and
-- publishes, or, when the warehouse lacks the room or the store is at its published cap, records
-- the approval (approved_needs_stock) and publishes nothing. Returns PUBLISHED or NEEDS_STOCK.
CREATE FUNCTION core.listing_publish(p_product uuid, p_version uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_p   core.product;
  v_wh  core.warehouse;
  v_qty int;
  v_ver core.product_version;
BEGIN
  SELECT * INTO v_p FROM core.product p WHERE p.id = p_product;
  SELECT * INTO v_ver FROM core.product_version v WHERE v.id = p_version AND v.product_id = p_product;
  IF v_ver.id IS NULL OR v_p.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'listing_publish: not an unpublished product''s own version' USING ERRCODE = 'internal_error';
  END IF;
  SELECT * INTO v_wh FROM core.warehouse w WHERE w.company_id = v_p.company_id AND w.kind = 'STARTER';
  v_qty := CASE WHEN v_p.inventory_mode = 'EXCLUSIVE' THEN v_p.exclusive_supply ELSE v_p.planned_quantity END;
  IF v_wh.id IS NULL OR v_qty IS NULL OR v_wh.capacity - v_wh.used < v_qty
     OR core.listing_live_count(v_p.company_id) >= core.listing_cap('listing_published_max', 10) THEN
    UPDATE core.product p
       SET status = 'DRAFT', approved_needs_stock = true, current_version_id = p_version,
           pending_version_id = p_version, updated_at = clock_timestamp()
     WHERE p.id = v_p.id;
    RETURN 'NEEDS_STOCK';
  END IF;
  INSERT INTO core.inventory_unit (id, product_id, warehouse_id, serial, state)
  SELECT core.uuid_v7(), v_p.id, v_wh.id, CASE WHEN v_p.inventory_mode = 'EXCLUSIVE' THEN g END, 'AVAILABLE'
    FROM generate_series(1, v_qty) g;
  UPDATE core.warehouse w SET used = w.used + v_qty WHERE w.id = v_wh.id;
  IF v_p.inventory_mode = 'EXCLUSIVE' THEN
    INSERT INTO core.exclusive_edition (product_id, supply) VALUES (v_p.id, v_qty);
  END IF;
  UPDATE core.product p
     SET status = 'PUBLISHED', published_at = clock_timestamp(), current_version_id = p_version,
         pending_version_id = NULL, approved_needs_stock = false, available_units = p.available_units + v_qty,
         moderation_reason = NULL, updated_at = clock_timestamp()
   WHERE p.id = v_p.id;
  INSERT INTO core.price_history (product_id, version_id, price_paise, previous_paise, reason)
  VALUES (v_p.id, p_version, v_ver.price_paise, NULL, 'PUBLISHED');
  INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
  VALUES (core.uuid_v7(), 'listing_published', v_p.id, jsonb_build_object(
    'productId', v_p.id, 'versionId', p_version, 'companyId', v_p.company_id, 'inventoryMode', v_p.inventory_mode,
    'units', v_qty, 'pricePaise', v_ver.price_paise::text), 1);
  RETURN 'PUBLISHED';
END $$;

-- Approves an open submission (callers hold the locks): a first publication publishes (or waits
-- for stock); a revision becomes the live version at the live price. Returns PUBLISHED,
-- NEEDS_STOCK or REVISED.
CREATE FUNCTION core.listing_approve(p_submission uuid, p_by text, p_reason text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_s       core.listing_submission;
  v_p       core.product;
  v_pinned  core.product_version;
  v_live    core.product_version;
  v_target  uuid;
  v_outcome text;
BEGIN
  SELECT * INTO v_s FROM core.listing_submission s WHERE s.id = p_submission;
  UPDATE core.listing_submission s
     SET state = 'APPROVED', decided_by = p_by, decision_reason = p_reason, decided_at = clock_timestamp()
   WHERE s.id = v_s.id;
  IF v_s.kind = 'FIRST' THEN
    RETURN core.listing_publish(v_s.product_id, v_s.version_id);
  END IF;
  SELECT * INTO v_p FROM core.product p WHERE p.id = v_s.product_id;
  SELECT * INTO v_pinned FROM core.product_version v WHERE v.id = v_s.version_id;
  SELECT * INTO v_live FROM core.product_version v WHERE v.id = v_p.current_version_id;
  v_target := v_pinned.id;
  IF v_pinned.price_paise <> v_live.price_paise THEN
    -- the price changed while the revision waited: the approved text goes live at the live price
    v_target := core.listing_new_version(v_p.id, v_pinned.name, v_pinned.hook, v_pinned.description,
                                         v_pinned.alt_text, v_pinned.template_id, v_live.price_paise,
                                         v_pinned.author_user_id);
  END IF;
  UPDATE core.product p SET current_version_id = v_target, pending_version_id = NULL, updated_at = clock_timestamp()
   WHERE p.id = v_p.id;
  INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
  VALUES (core.uuid_v7(), 'listing_revised', v_p.id, jsonb_build_object(
    'productId', v_p.id, 'versionId', v_target, 'companyId', v_p.company_id), 1);
  v_outcome := 'REVISED';
  RETURN v_outcome;
END $$;

-- A rejection of an open submission (callers hold the locks).
CREATE FUNCTION core.listing_reject(p_submission uuid, p_reasons jsonb, p_by text, p_reason text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_s core.listing_submission;
BEGIN
  SELECT * INTO v_s FROM core.listing_submission s WHERE s.id = p_submission;
  UPDATE core.listing_submission s
     SET state = 'REJECTED', reasons = COALESCE(p_reasons, s.reasons), decided_by = p_by, decision_reason = p_reason,
         decided_at = clock_timestamp()
   WHERE s.id = v_s.id;
  IF v_s.kind = 'FIRST' THEN
    UPDATE core.product p SET status = 'REJECTED', pending_version_id = NULL, moderation_reason = p_reason,
                              updated_at = clock_timestamp()
     WHERE p.id = v_s.product_id;
  ELSE
    UPDATE core.product p SET pending_version_id = NULL, updated_at = clock_timestamp() WHERE p.id = v_s.product_id;
  END IF;
END $$;

-- ---------------------------------------------------------------- the screening job (app_jobs)
-- Revisions waiting for screening, oldest first, with the text to screen.
CREATE FUNCTION core.screening_pending(p_limit int)
RETURNS TABLE (submission_id uuid, product_id uuid, version_id uuid, kind text, name text, hook text,
               description text, alt_text text, submitted_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.id, s.product_id, s.version_id, s.kind, v.name, v.hook, v.description, v.alt_text, s.submitted_at
    FROM core.listing_submission s JOIN core.product_version v ON v.id = s.version_id
   WHERE s.state = 'SCREENING'
   ORDER BY s.submitted_at, s.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100)
$$;

-- The screening verdict for a pinned revision: OK publishes (or approves a revision), NEEDS_REVIEW
-- queues it for the Super Admin, REJECT rejects it with the reasons. CONFLICT unless the version is
-- still the one pinned in SCREENING (a later edit, a newer revision or an applied result). With
-- publication switched off nothing is applied: {outcome: 'PAUSED'}.
CREATE FUNCTION core.screening_apply(p_product uuid, p_version uuid, p_verdict text, p_reasons jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_company uuid;
  v_s       core.listing_submission;
  v_p       core.product;
  v_outcome text;
  v_reasons jsonb := COALESCE(p_reasons, '[]'::jsonb);
BEGIN
  PERFORM ledger.require_read_committed();
  IF p_verdict IS NULL OR p_verdict NOT IN ('OK', 'NEEDS_REVIEW', 'REJECT') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'verdict is OK, NEEDS_REVIEW or REJECT');
  END IF;
  IF jsonb_typeof(v_reasons) <> 'array' OR jsonb_array_length(v_reasons) > 40 OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_reasons) r
        WHERE jsonb_typeof(r) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(r)) <> 2
           OR r ->> 'field' IS NULL OR r ->> 'field' NOT IN ('name', 'hook', 'description', 'altText')
           OR r ->> 'code' IS NULL OR r ->> 'code' !~ '^[A-Z_]{2,32}$') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'reasons are [{field, code}] for the listing fields');
  END IF;
  IF NOT core.switch_on('publication') THEN
    RETURN jsonb_build_object('outcome', 'PAUSED', 'productId', p_product, 'versionId', p_version);
  END IF;
  SELECT p.company_id INTO v_company FROM core.product p WHERE p.id = p_product AND p.seller_type = 'USER';
  IF v_company IS NULL THEN
    PERFORM core.fail('NOT_FOUND', 'product not found');
  END IF;
  PERFORM core.listing_lock(v_company, p_product);
  SELECT * INTO v_p FROM core.product p WHERE p.id = p_product;
  SELECT * INTO v_s FROM core.listing_submission s WHERE s.product_id = p_product AND s.state = 'SCREENING';
  IF v_s.id IS NULL OR v_s.version_id IS DISTINCT FROM p_version OR v_p.pending_version_id IS DISTINCT FROM p_version
     OR (v_s.kind = 'FIRST' AND v_p.status <> 'SCREENING') THEN
    PERFORM core.fail('CONFLICT', 'that revision is no longer the one waiting for screening');
  END IF;
  IF p_verdict = 'REJECT' THEN
    PERFORM core.listing_reject(v_s.id, v_reasons, 'SCREENING', NULL);
    v_outcome := 'REJECTED';
  ELSIF p_verdict = 'NEEDS_REVIEW' THEN
    UPDATE core.listing_submission s SET state = 'NEEDS_REVIEW', reasons = v_reasons WHERE s.id = v_s.id;
    IF v_s.kind = 'FIRST' THEN
      UPDATE core.product p SET status = 'NEEDS_REVIEW', updated_at = clock_timestamp() WHERE p.id = p_product;
    END IF;
    v_outcome := 'NEEDS_REVIEW';
  ELSE
    UPDATE core.listing_submission s SET reasons = v_reasons WHERE s.id = v_s.id;
    v_outcome := core.listing_approve(v_s.id, 'SCREENING', NULL);
  END IF;
  PERFORM core.listing_checks();
  RETURN jsonb_build_object('outcome', v_outcome, 'productId', p_product, 'versionId', p_version);
END $$;

-- ---------------------------------------------------------------- stock and live-listing commands
-- An approved listing that waited for stock: the owner (optionally) lowers the quantity (an
-- EXCLUSIVE supply may only be lowered, and only before the first publication) and publishes.
CREATE FUNCTION core.product_allocate_and_publish(p_product uuid, p_quantity int) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_company core.company := core.listing_studio();
  v_p       core.product := core.listing_own_locked(v_company.id, p_product);
  v_qty     int;
  v_wh      core.warehouse;
  v_problem text[];
BEGIN
  IF v_p.published_at IS NOT NULL OR v_p.status <> 'DRAFT' OR NOT v_p.approved_needs_stock THEN
    PERFORM core.fail('NOT_EDITABLE', 'only an approved listing waiting for stock is allocated here');
  END IF;
  IF NOT core.switch_on('publication') THEN
    PERFORM core.fail('PUBLICATION_PAUSED', 'publication is paused; try again later');
  END IF;
  v_qty := COALESCE(p_quantity, CASE WHEN v_p.inventory_mode = 'EXCLUSIVE' THEN v_p.exclusive_supply ELSE v_p.planned_quantity END);
  v_problem := core.listing_quantity_problem(v_qty);
  IF v_problem IS NOT NULL THEN PERFORM core.fail(v_problem[1], v_problem[2]); END IF;
  IF v_p.inventory_mode = 'EXCLUSIVE' AND v_qty > v_p.exclusive_supply THEN
    PERFORM core.fail('VALIDATION_FAILED', 'an exclusive supply may only be lowered');
  END IF;
  IF core.listing_live_count(v_company.id) >= core.listing_cap('listing_published_max', 10) THEN
    PERFORM core.fail('PUBLISH_LIMIT', 'your store has as many published listings as it may; archive one first');
  END IF;
  SELECT * INTO v_wh FROM core.warehouse w WHERE w.company_id = v_company.id AND w.kind = 'STARTER';
  IF v_wh.id IS NULL OR v_wh.capacity - v_wh.used < v_qty THEN
    PERFORM core.fail('CAPACITY_EXCEEDED', 'the warehouse has no room for that many units; free space or lower the quantity');
  END IF;
  UPDATE core.product p
     SET exclusive_supply = CASE WHEN p.inventory_mode = 'EXCLUSIVE' THEN v_qty END,
         planned_quantity = CASE WHEN p.inventory_mode = 'STANDARD_STOCKED' THEN v_qty END
   WHERE p.id = v_p.id;
  IF core.listing_publish(v_p.id, v_p.pending_version_id) <> 'PUBLISHED' THEN
    RAISE EXCEPTION 'allocate_and_publish: publication did not happen' USING ERRCODE = 'internal_error';
  END IF;
  PERFORM core.listing_checks();
  RETURN core.listing_result(v_p.id);
END $$;

-- More units of a published STANDARD_STOCKED listing, in the starter warehouse, within its room.
CREATE FUNCTION core.product_restock(p_product uuid, p_quantity int) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_company core.company := core.listing_studio();
  v_p       core.product := core.listing_own_locked(v_company.id, p_product);
  v_wh      core.warehouse;
  v_problem text[] := core.listing_quantity_problem(p_quantity);
BEGIN
  IF v_problem IS NOT NULL THEN PERFORM core.fail(v_problem[1], v_problem[2]); END IF;
  IF v_p.inventory_mode <> 'STANDARD_STOCKED' THEN
    PERFORM core.fail('NOT_EDITABLE', 'an exclusive edition is never restocked');
  END IF;
  IF v_p.status <> 'PUBLISHED' THEN
    PERFORM core.fail('NOT_EDITABLE', 'only a published listing is restocked');
  END IF;
  SELECT * INTO v_wh FROM core.warehouse w WHERE w.company_id = v_company.id AND w.kind = 'STARTER';
  IF v_wh.capacity - v_wh.used < p_quantity THEN
    PERFORM core.fail('CAPACITY_EXCEEDED', 'the warehouse has no room for that many units');
  END IF;
  INSERT INTO core.inventory_unit (id, product_id, warehouse_id, serial, state)
  SELECT core.uuid_v7(), v_p.id, v_wh.id, NULL, 'AVAILABLE' FROM generate_series(1, p_quantity);
  UPDATE core.warehouse w SET used = w.used + p_quantity WHERE w.id = v_wh.id;
  UPDATE core.product p SET available_units = p.available_units + p_quantity, updated_at = clock_timestamp()
   WHERE p.id = v_p.id;
  INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
  VALUES (core.uuid_v7(), 'listing_stock_changed', v_p.id, jsonb_build_object(
    'productId', v_p.id, 'companyId', v_company.id, 'change', 'RESTOCK', 'units', p_quantity), 1);
  PERFORM core.listing_checks();
  RETURN core.listing_result(v_p.id);
END $$;

-- Retires AVAILABLE units (they free their slots and are never sold); for an EXCLUSIVE edition
-- this permanently lowers how many can ever be sold (the highest serials go first).
CREATE FUNCTION core.listing_retire(p_product uuid, p_quantity int) RETURNS int
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ids uuid[];
BEGIN
  -- #7 the units, after the company, warehouses and product (callers hold those)
  SELECT array_agg(x.id) INTO v_ids FROM (
    SELECT u.id FROM core.inventory_unit u WHERE u.product_id = p_product AND u.state = 'AVAILABLE'
     ORDER BY u.serial DESC NULLS FIRST, u.id DESC LIMIT p_quantity FOR NO KEY UPDATE) x;
  IF v_ids IS NULL THEN RETURN 0; END IF;
  UPDATE core.inventory_unit u SET state = 'RETIRED_UNSOLD' WHERE u.id = ANY (v_ids);
  UPDATE core.warehouse w
     SET used = (SELECT count(*) FROM core.inventory_unit u WHERE u.warehouse_id = w.id AND u.state = 'AVAILABLE')
   WHERE w.id IN (SELECT u.warehouse_id FROM core.inventory_unit u WHERE u.id = ANY (v_ids));
  UPDATE core.product p
     SET available_units = (SELECT count(*) FROM core.inventory_unit u WHERE u.product_id = p.id AND u.state = 'AVAILABLE'),
         updated_at = clock_timestamp()
   WHERE p.id = p_product;
  RETURN cardinality(v_ids);
END $$;

CREATE FUNCTION core.product_retire_units(p_product uuid, p_quantity int) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_company core.company := core.listing_studio();
  v_p       core.product := core.listing_own_locked(v_company.id, p_product);
  v_n       int;
  v_problem text[] := core.listing_quantity_problem(p_quantity);
BEGIN
  IF v_problem IS NOT NULL THEN PERFORM core.fail(v_problem[1], v_problem[2]); END IF;
  IF v_p.status NOT IN ('PUBLISHED', 'HIDDEN') THEN
    PERFORM core.fail('NOT_EDITABLE', 'only a live listing''s units are retired');
  END IF;
  IF p_quantity > v_p.available_units THEN
    PERFORM core.fail('VALIDATION_FAILED', 'that is more units than are available');
  END IF;
  v_n := core.listing_retire(v_p.id, p_quantity);
  INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
  VALUES (core.uuid_v7(), 'listing_stock_changed', v_p.id, jsonb_build_object(
    'productId', v_p.id, 'companyId', v_company.id, 'change', 'RETIRE', 'units', v_n), 1);
  PERFORM core.listing_checks();
  RETURN core.listing_result(v_p.id) || jsonb_build_object('retired', v_n,
    -- an exclusive edition can now sell at most this many in total (issued + still available)
    'sellableSupply', CASE WHEN v_p.inventory_mode = 'EXCLUSIVE' THEN (
       SELECT count(*) FROM core.inventory_unit u WHERE u.product_id = v_p.id
          AND u.state IN ('AVAILABLE', 'ISSUED', 'REVOKED_ISSUED')) END);
END $$;

-- PUBLISHED -> ARCHIVED: off sale for good; its remaining units are retired and any open
-- revision withdrawn. Owners keep what they bought.
CREATE FUNCTION core.product_archive(p_product uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_company core.company := core.listing_studio();
  v_p       core.product := core.listing_own_locked(v_company.id, p_product);
  v_n       int;
BEGIN
  IF v_p.status <> 'PUBLISHED' THEN
    PERFORM core.fail('NOT_EDITABLE', 'only a published listing is archived');
  END IF;
  v_n := core.listing_retire(v_p.id, v_p.available_units);
  UPDATE core.listing_submission s SET state = 'WITHDRAWN', decided_by = 'OWNER', decided_at = clock_timestamp()
   WHERE s.product_id = v_p.id AND s.state IN ('SCREENING', 'NEEDS_REVIEW');
  UPDATE core.product p SET status = 'ARCHIVED', pending_version_id = NULL, updated_at = clock_timestamp()
   WHERE p.id = v_p.id;
  INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
  VALUES (core.uuid_v7(), 'listing_archived', v_p.id, jsonb_build_object(
    'productId', v_p.id, 'companyId', v_company.id, 'retiredUnits', v_n), 1);
  PERFORM core.listing_checks();
  RETURN core.listing_result(v_p.id);
END $$;

-- A price-only change of a live listing: a new version with the approved text at the new price,
-- live at once (no screening), recorded in the price history. Quotes already given are re-derived
-- when they are paid (core.commit_purchase refuses a changed version: CART_CHANGED).
CREATE FUNCTION core.product_set_price(p_product uuid, p_price_paise bigint) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_company core.company := core.listing_studio();
  v_p       core.product := core.listing_own_locked(v_company.id, p_product);
  v_live    core.product_version;
  v_problem text[] := core.listing_price_problem(p_price_paise);
  v_version uuid;
BEGIN
  IF v_problem IS NOT NULL THEN PERFORM core.fail(v_problem[1], v_problem[2]); END IF;
  IF v_p.status <> 'PUBLISHED' THEN
    PERFORM core.fail('NOT_EDITABLE', 'only a published listing is repriced (edit the draft instead)');
  END IF;
  SELECT * INTO v_live FROM core.product_version v WHERE v.id = v_p.current_version_id;
  IF v_live.price_paise = p_price_paise THEN
    RETURN core.listing_result(v_p.id);
  END IF;
  v_version := core.listing_new_version(v_p.id, v_live.name, v_live.hook, v_live.description, v_live.alt_text,
                                        v_live.template_id, p_price_paise, v_company.owner_user_id);
  UPDATE core.product p SET current_version_id = v_version, updated_at = clock_timestamp() WHERE p.id = v_p.id;
  INSERT INTO core.price_history (product_id, version_id, price_paise, previous_paise, reason)
  VALUES (v_p.id, v_version, p_price_paise, v_live.price_paise, 'PRICE_CHANGE');
  INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
  VALUES (core.uuid_v7(), 'listing_price_changed', v_p.id, jsonb_build_object(
    'productId', v_p.id, 'versionId', v_version, 'companyId', v_company.id,
    'pricePaise', p_price_paise::text, 'previousPaise', v_live.price_paise::text), 1);
  PERFORM core.listing_checks();
  RETURN core.listing_result(v_p.id);
END $$;

-- Delivery options of an own listing (any status but ARCHIVED); NULL leaves one unchanged.
CREATE FUNCTION core.product_set_shipping(p_product uuid, p_offers_express boolean, p_free_standard_delivery boolean)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_company core.company := core.listing_studio();
  v_p       core.product := core.listing_own_locked(v_company.id, p_product);
BEGIN
  IF v_p.status = 'ARCHIVED' THEN
    PERFORM core.fail('NOT_EDITABLE', 'an archived listing does not change');
  END IF;
  UPDATE core.product p
     SET offers_express = COALESCE(p_offers_express, p.offers_express),
         free_standard_delivery = COALESCE(p_free_standard_delivery, p.free_standard_delivery),
         updated_at = clock_timestamp()
   WHERE p.id = v_p.id;
  PERFORM core.listing_checks();
  RETURN core.listing_result(v_p.id);
END $$;

-- Makes one of the owner's warehouses the company's Zap hub (at most one: the previous hub stops
-- being one), or stops it being one. Zap delivery of a USER product needs an AVAILABLE unit in the
-- hub (catalog, cart, checkout and pay agree on this).
CREATE FUNCTION core.warehouse_set_zap_hub(p_warehouse uuid, p_enabled boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_company core.company := core.listing_studio();
BEGIN
  IF p_enabled IS NULL THEN
    PERFORM core.fail('VALIDATION_FAILED', 'enabled is true or false');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.warehouse w WHERE w.id = p_warehouse AND w.company_id = v_company.id) THEN
    PERFORM core.fail('NOT_FOUND', 'warehouse not found');
  END IF;
  PERFORM core.listing_lock(v_company.id, NULL);
  IF p_enabled THEN
    UPDATE core.warehouse w SET zap_hub = false WHERE w.company_id = v_company.id AND w.id <> p_warehouse AND w.zap_hub;
  END IF;
  UPDATE core.warehouse w SET zap_hub = p_enabled WHERE w.id = p_warehouse;
  INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
  VALUES (core.uuid_v7(), 'warehouse_zap_hub_changed', p_warehouse, jsonb_build_object(
    'warehouseId', p_warehouse, 'companyId', v_company.id, 'zapHub', p_enabled), 1);
  PERFORM core.listing_checks();
  RETURN jsonb_build_object('warehouses', (
    SELECT jsonb_agg(jsonb_build_object('id', w.id, 'kind', w.kind, 'capacity', w.capacity, 'used', w.used,
                                        'zapHub', w.zap_hub) ORDER BY w.id)
      FROM core.warehouse w WHERE w.company_id = v_company.id));
END $$;

-- ---------------------------------------------------------------- privileges
REVOKE ALL ON FUNCTION
  core.listing_text_problem(text, text, text, text, int), core.listing_price_problem(bigint),
  core.listing_quantity_problem(int), core.listing_studio(), core.listing_lock(uuid, uuid),
  core.listing_own(uuid, uuid), core.listing_own_locked(uuid, uuid), core.listing_private_count(uuid),
  core.listing_live_count(uuid), core.listing_incoming_count(uuid, uuid), core.listing_submissions_today(uuid),
  core.listing_cap(text, bigint), core.listing_new_version(uuid, text, text, text, text, int, bigint, uuid),
  core.listing_version_json(core.product_version), core.listing_json(core.product), core.my_products(text, uuid, int),
  core.my_product(uuid), core.listing_result(uuid), core.listing_checks(),
  core.draft_create(text, text, text, text, int, text, bigint, text, int, boolean, boolean),
  core.draft_update(uuid, text, text, text, text, int, text, bigint, text, int, boolean, boolean),
  core.draft_delete(uuid), core.listing_open_submission(uuid, uuid, uuid, text), core.product_submit(uuid),
  core.product_revise(uuid, text, text, text, text, int), core.listing_publish(uuid, uuid),
  core.listing_approve(uuid, text, text), core.listing_reject(uuid, jsonb, text, text), core.screening_pending(int),
  core.screening_apply(uuid, uuid, text, jsonb), core.product_allocate_and_publish(uuid, int),
  core.product_restock(uuid, int), core.listing_retire(uuid, int), core.product_retire_units(uuid, int),
  core.product_archive(uuid), core.product_set_price(uuid, bigint), core.product_set_shipping(uuid, boolean, boolean),
  core.warehouse_set_zap_hub(uuid, boolean)
FROM PUBLIC;
-- the owner's studio (the database derives the owner from the sign-in session)
GRANT EXECUTE ON FUNCTION core.my_products(text, uuid, int), core.my_product(uuid),
  core.draft_create(text, text, text, text, int, text, bigint, text, int, boolean, boolean),
  core.draft_update(uuid, text, text, text, text, int, text, bigint, text, int, boolean, boolean),
  core.draft_delete(uuid), core.product_submit(uuid), core.product_revise(uuid, text, text, text, text, int),
  core.product_allocate_and_publish(uuid, int), core.product_restock(uuid, int), core.product_retire_units(uuid, int),
  core.product_archive(uuid), core.product_set_price(uuid, bigint), core.product_set_shipping(uuid, boolean, boolean),
  core.warehouse_set_zap_hub(uuid, boolean)
TO app_web;
-- the screening job only
GRANT EXECUTE ON FUNCTION core.screening_pending(int), core.screening_apply(uuid, uuid, text, jsonb) TO app_jobs;
