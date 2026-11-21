-- Saves and the Inventor Passport (US-05): the free route to creator access.
--
-- Saves (A). A signed-in, onboarded (provisioned) person saves and unsaves PUBLISHED products, one
-- save per person and product. core.product_save keeps the row when a product is unsaved
-- (unsaved_at set), so the database can tell a product the person has never saved from one saved
-- before (the relief grant of 0033 needs a newly saved product).
--
-- The passport (B). Three steps, any order, no timers, unlimited retries, kept in
-- core.passport_progress (so progress follows the person across devices):
--   1. the quiz: graded by the web server from packages/core/src/passport. The database records
--      only that it passed (or a failed try) and the rule version, never the answers.
--      TAKEN ON THE WEB SERVER'S WORD: whether the quiz passed.
--   2. three distinct PUBLISHED products saved: VERIFIED BY THE DATABASE from core.product_save
--      whenever progress is read or a step completes; once recorded the step stays complete
--      (unsaving later does not undo it).
--   3. a private invention concept of `passport_concept_min_chars`..`passport_concept_max_chars`
--      (20..280) characters after trimming, without control characters: lengths VERIFIED BY THE
--      DATABASE; the text screening verdict is TAKEN ON THE WEB SERVER'S WORD (only 'OK' is
--      accepted; anything else is refused and nothing is stored). The concept is stored in
--      private.invention_concept, readable by no application role, returned only to its owner.
-- When all three are complete the database grants the creator entitlement once (source
-- ACHIEVEMENT, with the rule version). There is only ever one entitlement per person (UNIQUE
-- user_id, 0015): whichever route comes second is recorded in core.creator_route_evidence.
--
-- The spending route (US-04) is unchanged (core.commit_purchase): its evidence row is recorded
-- here too, by core.commit_purchase, for every purchase that leaves the balance below the
-- threshold until the first one is recorded.
--
-- Every function derives the actor from the sign-in session and takes no user id; the writing
-- ones serialise per actor (core.lock_actor('core.progression', actor), taken first) and take the
-- passport row and then the entitlement (LLD §4 #10) last. No application role holds any privilege
-- on the new tables.

-- ---------------------------------------------------------------- rule constants
-- The current passport rule version (packages/core/src/passport PASSPORT_RULE_VERSION).
CREATE FUNCTION core.passport_rule_version() RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$ SELECT 'passport_v1'::text $$;

-- ---------------------------------------------------------------- saves
CREATE TABLE core.product_save (
  -- time-ordered; replaced when the product is saved again (the page cursor of core.my_saves)
  id             uuid NOT NULL UNIQUE,
  user_id        uuid NOT NULL REFERENCES core.user_profile (id) ON DELETE CASCADE,
  product_id     uuid NOT NULL REFERENCES core.product (id),
  first_saved_at timestamptz NOT NULL,
  saved_at       timestamptz NOT NULL,
  -- set while the product is unsaved; the row stays as the record that it was once saved
  unsaved_at     timestamptz,
  PRIMARY KEY (user_id, product_id)
);
CREATE INDEX product_save_user_active ON core.product_save (user_id, id) WHERE unsaved_at IS NULL;
CREATE INDEX product_save_product ON core.product_save (product_id);

-- ---------------------------------------------------------------- passport
CREATE TABLE core.passport_progress (
  user_id              uuid PRIMARY KEY REFERENCES core.user_profile (id) ON DELETE CASCADE,
  rule_version         text NOT NULL CHECK (rule_version ~ '^passport_v[0-9]+$'),
  quiz_passed_at       timestamptz,
  quiz_failed_count    int NOT NULL DEFAULT 0 CHECK (quiz_failed_count >= 0),
  saves_completed_at   timestamptz,
  concept_submitted_at timestamptz,
  completed_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (completed_at IS NULL OR (quiz_passed_at IS NOT NULL AND saves_completed_at IS NOT NULL
                                  AND concept_submitted_at IS NOT NULL))
);

-- The concept itself: private to its owner, never published, readable by no application role.
CREATE TABLE private.invention_concept (
  user_id      uuid PRIMARY KEY REFERENCES core.user_profile (id) ON DELETE CASCADE,
  concept      text NOT NULL CHECK (char_length(concept) BETWEEN 1 AND 1000),
  rule_version text NOT NULL,
  submitted_at timestamptz NOT NULL
);

-- ---------------------------------------------------------------- creator access: one entitlement, evidence per route
ALTER TABLE core.creator_entitlement DROP CONSTRAINT creator_entitlement_source_check;
ALTER TABLE core.creator_entitlement
  ADD CONSTRAINT creator_entitlement_source_check CHECK (source IN ('PURCHASE_THRESHOLD', 'ACHIEVEMENT')),
  ADD COLUMN rule_version text,
  ADD CONSTRAINT creator_entitlement_achievement_check
    CHECK (source <> 'ACHIEVEMENT' OR (rule_version IS NOT NULL AND evidence_order_group_id IS NULL));

-- Every route a person has reached, the first one included: SPEND (a completed purchase left the
-- balance below the threshold) and PASSPORT (all three steps complete).
CREATE TABLE core.creator_route_evidence (
  user_id                 uuid NOT NULL REFERENCES core.user_profile (id),
  route                   text NOT NULL CHECK (route IN ('SPEND', 'PASSPORT')),
  evidence_order_group_id uuid REFERENCES core.order_group (id),
  rule_version            text,
  recorded_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, route),
  CHECK ((route = 'SPEND') = (evidence_order_group_id IS NOT NULL)),
  CHECK ((route = 'PASSPORT') = (rule_version IS NOT NULL))
);

ALTER TABLE core.product_save ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.passport_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.invention_concept ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.creator_route_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.product_save, core.passport_progress, private.invention_concept, core.creator_route_evidence
  FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;
-- No grant exists; these policies only say what a grant would have to respect: one's own rows.
CREATE POLICY own_rows ON core.product_save FOR SELECT TO app_web, app_pay USING (user_id = core.actor_id());
CREATE POLICY own_rows ON core.passport_progress FOR SELECT TO app_web, app_pay USING (user_id = core.actor_id());
CREATE POLICY own_rows ON private.invention_concept FOR SELECT TO app_web USING (user_id = core.actor_id());
CREATE POLICY own_rows ON core.creator_route_evidence FOR SELECT TO app_web, app_pay USING (user_id = core.actor_id());

-- Evidence is a record of how a permission was earned: never deleted.
CREATE TRIGGER no_delete BEFORE DELETE ON core.creator_route_evidence
  FOR EACH ROW EXECUTE FUNCTION core.refuse_delete();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON core.creator_route_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION core.refuse_delete();
CREATE FUNCTION core.guard_route_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'creator route evidence % / % never changes', OLD.user_id, OLD.route USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER guard BEFORE UPDATE ON core.creator_route_evidence
  FOR EACH ROW EXECUTE FUNCTION core.guard_route_evidence();

-- ---------------------------------------------------------------- structural checks (second line)
-- A completed passport: all three steps and the completion recorded, under the given rule version.
CREATE FUNCTION core.passport_complete(p_user uuid, p_rule_version text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM core.passport_progress pp
                  WHERE pp.user_id = p_user AND pp.rule_version = p_rule_version
                    AND pp.quiz_passed_at IS NOT NULL AND pp.saves_completed_at IS NOT NULL
                    AND pp.concept_submitted_at IS NOT NULL AND pp.completed_at IS NOT NULL)
$$;

-- 0016's check for rows that join an order group, now also for ACHIEVEMENT entitlements: those
-- name no order group and need a completed passport under their rule version instead.
CREATE OR REPLACE FUNCTION core.assert_joins_new_group() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  grp   uuid;
  buyer uuid;
  ok    boolean;
BEGIN
  PERFORM ledger.require_read_committed();
  CASE TG_TABLE_NAME
    WHEN 'seller_order' THEN
      SELECT g.id INTO grp FROM core.order_group g
       WHERE g.id = NEW.order_group_id AND g.buyer_user_id = NEW.buyer_user_id AND g.created_txid = txid_current();
    WHEN 'order_line' THEN
      SELECT g.id INTO grp FROM core.seller_order so JOIN core.order_group g ON g.id = so.order_group_id
       WHERE so.id = NEW.seller_order_id AND g.created_txid = txid_current();
    WHEN 'shipment' THEN
      SELECT g.id INTO grp FROM core.seller_order so JOIN core.order_group g ON g.id = so.order_group_id
       WHERE so.id = NEW.seller_order_id AND g.created_txid = txid_current();
    WHEN 'ownership' THEN
      SELECT g.id INTO grp FROM core.order_line l
        JOIN core.seller_order so ON so.id = l.seller_order_id
        JOIN core.order_group g ON g.id = so.order_group_id
       WHERE l.id = NEW.order_line_id AND l.product_id = NEW.product_id
         AND g.buyer_user_id = NEW.user_id AND g.created_txid = txid_current();
    WHEN 'coupon_redemption' THEN
      SELECT g.id INTO grp FROM core.order_group g
       WHERE g.id = NEW.order_group_id AND g.buyer_user_id = NEW.user_id AND g.created_txid = txid_current();
    WHEN 'creator_entitlement' THEN
      IF NEW.source = 'ACHIEVEMENT' THEN
        IF NOT core.passport_complete(NEW.user_id, NEW.rule_version) THEN
          RAISE EXCEPTION 'creator entitlement for %: an ACHIEVEMENT needs a completed passport (%)', NEW.user_id,
            NEW.rule_version USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END IF;
      SELECT g.id, g.buyer_user_id INTO grp, buyer FROM core.order_group g
       WHERE g.id = NEW.evidence_order_group_id AND g.buyer_user_id = NEW.user_id AND g.created_txid = txid_current();
      IF grp IS NOT NULL THEN
        SELECT w.available_paise < core.config_paise(g.config_version, ARRAY['creator_threshold_paise'], 1000000000)
          INTO ok
          FROM core.order_group g
          JOIN ledger.ledger_account la ON la.user_id = g.buyer_user_id AND la.type = 'USER'
          JOIN ledger.wallet w ON w.account_id = la.id
         WHERE g.id = grp;
        IF ok IS NOT TRUE THEN
          RAISE EXCEPTION 'creator entitlement for %: the wallet is not below the creator threshold', NEW.user_id
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
  END CASE;
  IF grp IS NULL THEN
    RAISE EXCEPTION '% row must belong to an order group of the same user created in this transaction', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

-- Evidence is recorded only for the route really reached, and only next to an entitlement.
CREATE FUNCTION core.assert_route_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ok boolean;
BEGIN
  PERFORM ledger.require_read_committed();
  IF NOT EXISTS (SELECT 1 FROM core.creator_entitlement ce WHERE ce.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'creator route evidence for %: there is no creator entitlement', NEW.user_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.route = 'PASSPORT' THEN
    IF NOT core.passport_complete(NEW.user_id, NEW.rule_version) THEN
      RAISE EXCEPTION 'creator route evidence for %: the passport is not complete', NEW.user_id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT w.available_paise < core.config_paise(g.config_version, ARRAY['creator_threshold_paise'], 1000000000)
      INTO ok
      FROM core.order_group g
      JOIN ledger.ledger_account la ON la.user_id = g.buyer_user_id AND la.type = 'USER'
      JOIN ledger.wallet w ON w.account_id = la.id
     WHERE g.id = NEW.evidence_order_group_id AND g.buyer_user_id = NEW.user_id
       AND g.created_txid = txid_current();
    IF ok IS NOT TRUE THEN
      RAISE EXCEPTION 'creator route evidence for %: SPEND needs an own purchase of this transaction leaving the wallet below the threshold',
        NEW.user_id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER route_evidence AFTER INSERT ON core.creator_route_evidence
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.assert_route_evidence();

-- A passport step, once complete, stays complete; the completion is set once; the rule version
-- never changes once anything is recorded under it.
CREATE FUNCTION core.guard_passport_progress() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (OLD.quiz_passed_at IS NOT NULL AND NEW.quiz_passed_at IS DISTINCT FROM OLD.quiz_passed_at)
     OR (OLD.saves_completed_at IS NOT NULL AND NEW.saves_completed_at IS DISTINCT FROM OLD.saves_completed_at)
     OR (OLD.concept_submitted_at IS NOT NULL AND NEW.concept_submitted_at IS DISTINCT FROM OLD.concept_submitted_at)
     OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
     OR NEW.rule_version IS DISTINCT FROM OLD.rule_version
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'passport progress of %: a completed step is never undone', OLD.user_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard BEFORE UPDATE ON core.passport_progress
  FOR EACH ROW EXECUTE FUNCTION core.guard_passport_progress();

-- ---------------------------------------------------------------- helpers
-- The signed-in, provisioned actor, holding the actor's progression lock (taken first by every
-- writing function here and in 0033/0034, so one person's saves, passport steps, relief claims
-- and company registration run one at a time).
CREATE FUNCTION core.progression_actor() RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := core.require_actor();
BEGIN
  PERFORM ledger.require_read_committed();
  IF NOT EXISTS (SELECT 1 FROM core.user_profile up WHERE up.id = actor AND up.provisioned_at IS NOT NULL) THEN
    PERFORM core.fail('ONBOARDING_REQUIRED', 'finish onboarding first');
  END IF;
  PERFORM core.lock_actor('core.progression', actor);
  RETURN actor;
END $$;

-- Products the actor has saved and not unsaved that are PUBLISHED now.
CREATE FUNCTION core.published_saves(p_user uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT count(*) FROM core.product_save s JOIN core.product p ON p.id = s.product_id
   WHERE s.user_id = p_user AND s.unsaved_at IS NULL AND p.status = 'PUBLISHED' AND p.current_version_id IS NOT NULL
$$;

-- Records what is now complete and grants the entitlement when all three steps are. The caller
-- holds the actor's progression lock. Locks: the passport row, then the entitlement (§4 #10).
CREATE FUNCTION core.passport_evaluate(actor uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  pp  core.passport_progress;
  cfg int := core.current_config_id();
BEGIN
  INSERT INTO core.passport_progress (user_id, rule_version) VALUES (actor, core.passport_rule_version())
  ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO pp FROM core.passport_progress p WHERE p.user_id = actor FOR UPDATE;
  IF pp.saves_completed_at IS NULL
     AND core.published_saves(actor) >= core.config_int(cfg, ARRAY['passport_saves_required'], 3) THEN
    UPDATE core.passport_progress p SET saves_completed_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE p.user_id = actor RETURNING * INTO pp;
  END IF;
  IF pp.completed_at IS NULL AND pp.quiz_passed_at IS NOT NULL AND pp.saves_completed_at IS NOT NULL
     AND pp.concept_submitted_at IS NOT NULL THEN
    UPDATE core.passport_progress p SET completed_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE p.user_id = actor;
    -- one entitlement per person: when the spending route came first, this is evidence only
    INSERT INTO core.creator_entitlement (id, user_id, source, rule_version)
    VALUES (core.uuid_v7(), actor, 'ACHIEVEMENT', pp.rule_version) ON CONFLICT (user_id) DO NOTHING;
    INSERT INTO core.creator_route_evidence (user_id, route, rule_version)
    VALUES (actor, 'PASSPORT', pp.rule_version) ON CONFLICT DO NOTHING;
  END IF;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
END $$;

-- The actor's passport as shown to its owner (the concept included: it is theirs).
CREATE FUNCTION core.passport_json(actor uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object(
    'ruleVersion', COALESCE(pp.rule_version, core.passport_rule_version()),
    'quiz', jsonb_build_object('done', pp.quiz_passed_at IS NOT NULL, 'completedAt', pp.quiz_passed_at,
                               'failedAttempts', COALESCE(pp.quiz_failed_count, 0)),
    'saves', jsonb_build_object('done', pp.saves_completed_at IS NOT NULL, 'completedAt', pp.saves_completed_at,
                                'count', core.published_saves(actor),
                                'required', core.config_int(core.current_config_id(), ARRAY['passport_saves_required'], 3)),
    'concept', jsonb_build_object('done', pp.concept_submitted_at IS NOT NULL, 'completedAt', pp.concept_submitted_at,
                                  'text', ic.concept),
    'completedAt', pp.completed_at)
    FROM (SELECT actor AS id) a
    LEFT JOIN core.passport_progress pp ON pp.user_id = a.id
    LEFT JOIN private.invention_concept ic ON ic.user_id = a.id
$$;

-- ---------------------------------------------------------------- saves
CREATE FUNCTION core.save_product(product_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor uuid := core.progression_actor();
BEGIN
  IF save_product.product_id IS NULL THEN
    PERFORM core.fail('VALIDATION_FAILED', 'productId is required');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.product_save s
                  WHERE s.user_id = actor AND s.product_id = save_product.product_id AND s.unsaved_at IS NULL) THEN
    IF NOT EXISTS (SELECT 1 FROM core.product p JOIN core.product_version v ON v.id = p.current_version_id
                    WHERE p.id = save_product.product_id AND v.product_id = p.id AND p.status = 'PUBLISHED') THEN
      PERFORM core.fail('PRODUCT_UNAVAILABLE', 'that product is not available');
    END IF;
    INSERT INTO core.product_save AS s (id, user_id, product_id, first_saved_at, saved_at)
    VALUES (core.uuid_v7(), actor, save_product.product_id, clock_timestamp(), clock_timestamp())
    ON CONFLICT ON CONSTRAINT product_save_pkey
      DO UPDATE SET id = EXCLUDED.id, saved_at = EXCLUDED.saved_at, unsaved_at = NULL;
  END IF;
  PERFORM core.passport_evaluate(actor);
  RETURN jsonb_build_object('productId', save_product.product_id, 'saved', true);
END $$;

CREATE FUNCTION core.unsave_product(product_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor uuid := core.progression_actor();
BEGIN
  UPDATE core.product_save s SET unsaved_at = clock_timestamp()
   WHERE s.user_id = actor AND s.product_id = unsave_product.product_id AND s.unsaved_at IS NULL;
  RETURN jsonb_build_object('productId', unsave_product.product_id, 'saved', false);
END $$;

-- The actor's saved products, newest save first (cursor: the last save_id seen). A product that is
-- no longer published stays listed, with published = false and no name or price.
CREATE FUNCTION core.my_saves(cursor uuid, page_size int)
RETURNS TABLE (save_id uuid, product_id uuid, saved_at timestamptz, published boolean, name text,
               price_paise bigint, seller_name text, available boolean, template_id int, alt_text text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.id, s.product_id, s.saved_at, r.product_id IS NOT NULL, r.name, r.price_paise, r.seller_name,
         COALESCE(r.available, false), r.template_id, r.alt_text
    FROM core.product_save s
    JOIN core.product p ON p.id = s.product_id
    LEFT JOIN LATERAL core.catalog_row(p) r ON true
   WHERE s.user_id = core.require_actor() AND s.unsaved_at IS NULL
     AND (my_saves.cursor IS NULL OR s.id < my_saves.cursor)
   ORDER BY s.id DESC
   LIMIT core.page_size(my_saves.page_size)
$$;

-- ---------------------------------------------------------------- passport commands
-- Reading progress evaluates the saves step (and may complete the passport).
CREATE FUNCTION core.passport_progress() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor uuid := core.progression_actor();
BEGIN
  PERFORM core.passport_evaluate(actor);
  RETURN core.passport_json(actor);
END $$;

-- Step 1. `passed` is the web server's grading of the answers under `rule_version`; a failed try
-- is counted and may be retried without limit. A pass is kept.
CREATE FUNCTION core.passport_record_quiz(passed boolean, rule_version text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor uuid := core.progression_actor();
BEGIN
  IF passed IS NULL THEN
    PERFORM core.fail('VALIDATION_FAILED', 'passed is true or false');
  END IF;
  IF passport_record_quiz.rule_version IS DISTINCT FROM core.passport_rule_version() THEN
    PERFORM core.fail('VALIDATION_FAILED', 'the quiz was graded under an unknown rule version');
  END IF;
  INSERT INTO core.passport_progress (user_id, rule_version) VALUES (actor, core.passport_rule_version())
  ON CONFLICT (user_id) DO NOTHING;
  IF passed THEN
    UPDATE core.passport_progress p
       SET quiz_passed_at = COALESCE(p.quiz_passed_at, clock_timestamp()), updated_at = clock_timestamp()
     WHERE p.user_id = actor;
  ELSE
    UPDATE core.passport_progress p
       SET quiz_failed_count = least(p.quiz_failed_count, 1000000) + 1, updated_at = clock_timestamp()
     WHERE p.user_id = actor;
  END IF;
  PERFORM core.passport_evaluate(actor);
  RETURN core.passport_json(actor);
END $$;

-- Step 3. `screening` is the web server's verdict on the text (packages/core/src/screening); only
-- 'OK' is accepted, anything else is VALIDATION_FAILED and nothing is stored. The length and the
-- absence of control characters (a newline is allowed) are checked here. A later submission
-- replaces the text; the step stays complete.
CREATE FUNCTION core.passport_submit_concept(concept text, screening text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor uuid := core.progression_actor();
  cfg   int := core.current_config_id();
  txt   text := btrim(passport_submit_concept.concept);
BEGIN
  IF screening IS DISTINCT FROM 'OK' THEN
    PERFORM core.fail('VALIDATION_FAILED', 'the concept did not pass text screening');
  END IF;
  IF txt IS NULL
     OR char_length(txt) < core.config_int(cfg, ARRAY['passport_concept_min_chars'], 20)
     OR char_length(txt) > core.config_int(cfg, ARRAY['passport_concept_max_chars'], 280) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'the concept is 20 to 280 characters');
  END IF;
  IF txt ~ '[\x01-\x09\x0b-\x1f\x7f]' THEN
    PERFORM core.fail('VALIDATION_FAILED', 'the concept may not contain control characters');
  END IF;
  INSERT INTO private.invention_concept AS ic (user_id, concept, rule_version, submitted_at)
  VALUES (actor, txt, core.passport_rule_version(), clock_timestamp())
  ON CONFLICT (user_id) DO UPDATE SET concept = EXCLUDED.concept, rule_version = EXCLUDED.rule_version,
                                      submitted_at = EXCLUDED.submitted_at;
  INSERT INTO core.passport_progress (user_id, rule_version) VALUES (actor, core.passport_rule_version())
  ON CONFLICT (user_id) DO NOTHING;
  UPDATE core.passport_progress p
     SET concept_submitted_at = COALESCE(p.concept_submitted_at, clock_timestamp()), updated_at = clock_timestamp()
   WHERE p.user_id = actor;
  PERFORM core.passport_evaluate(actor);
  RETURN core.passport_json(actor);
END $$;

-- ---------------------------------------------------------------- creator access
-- {unlocked, source, unlockedAt, ruleVersion, routes: {spend: {balancePaise, thresholdPaise,
-- reached, reachedAt}, passport: <passport_json>}}. Evaluates the passport first.
CREATE FUNCTION core.creator_access() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor uuid := core.progression_actor();
  ent   core.creator_entitlement;
  spend core.creator_route_evidence;
  bal   bigint;
BEGIN
  PERFORM core.passport_evaluate(actor);
  SELECT * INTO ent FROM core.creator_entitlement ce WHERE ce.user_id = actor;
  SELECT * INTO spend FROM core.creator_route_evidence e WHERE e.user_id = actor AND e.route = 'SPEND';
  SELECT w.available_paise INTO bal FROM ledger.ledger_account la JOIN ledger.wallet w ON w.account_id = la.id
   WHERE la.user_id = actor AND la.type = 'USER';
  RETURN jsonb_build_object(
    'unlocked', ent.id IS NOT NULL,
    'source', ent.source,
    'unlockedAt', ent.unlocked_at,
    'ruleVersion', ent.rule_version,
    'routes', jsonb_build_object(
      'spend', jsonb_build_object(
        'balancePaise', bal::text,
        'thresholdPaise', core.config_paise(core.current_config_id(), ARRAY['creator_threshold_paise'], 1000000000)::text,
        'reached', spend.user_id IS NOT NULL OR ent.source IS NOT DISTINCT FROM 'PURCHASE_THRESHOLD',
        'reachedAt', COALESCE(spend.recorded_at, CASE WHEN ent.source = 'PURCHASE_THRESHOLD' THEN ent.unlocked_at END)),
      'passport', core.passport_json(actor)));
END $$;

-- ---------------------------------------------------------------- the spending route's evidence
-- core.commit_purchase of 0029, unchanged except that a purchase leaving the balance below the
-- creator threshold records the SPEND evidence (once), inside the same transaction and after every
-- lock of the purchase (the evidence row is the last write, §4 #10).
CREATE OR REPLACE FUNCTION core.commit_purchase(session_id uuid, attempt_id uuid, idempotency_key text, request_hash bytea,
                                     "order" jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor   uuid := core.actor_id();
  rec     core.idempotency_record;
  receipt jsonb;
  code    text;
  msg     text;
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  PERFORM ledger.require_read_committed();
  IF session_id IS NULL OR attempt_id IS NULL OR request_hash IS NULL THEN
    PERFORM core.fail('VALIDATION_FAILED', 'session, attempt and request hash are required');
  END IF;

  -- 1. idempotency
  rec := core.idem_begin(actor, 'pay', idempotency_key, request_hash);
  IF rec.status = 200 THEN
    RETURN jsonb_build_object('status', 'SUCCEEDED', 'replayed', true, 'receipt', rec.response,
      'reversed', EXISTS (SELECT 1 FROM core.seller_order so
                           WHERE so.order_group_id = (rec.response ->> 'orderGroupId')::uuid AND so.status = 'REVERSED'));
  ELSIF rec.status IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'FAILED', 'replayed', true, 'error', rec.response -> 'error');
  END IF;

  -- 2. switches, read inside the transaction; missing or off refuses
  IF NOT core.switch_on('purchases') THEN
    PERFORM core.fail('MAINTENANCE', 'purchases are switched off');
  END IF;

  -- 3-5. locks, validation, writes, checks
  BEGIN
    receipt := core.purchase_write(actor, commit_purchase.session_id, commit_purchase.attempt_id, "order");
    -- the bought products leave the buyer's cart in this same transaction (PRD R2.2); after
    -- every lock of the canonical order, on the buyer's own cart rows only
    DELETE FROM core.cart_line cl
     WHERE cl.user_id = actor
       AND cl.product_id IN (SELECT (l ->> 'productId')::uuid
                               FROM core.checkout_session cs, jsonb_array_elements(cs.quote -> 'lines') l
                              WHERE cs.id = commit_purchase.session_id AND cs.user_id = actor);
    -- US-04: the spending route reached (whether or not it is the route that unlocked)
    IF (receipt ->> 'balanceAfterPaise')::bigint < core.config_paise(
         (SELECT cs.config_version FROM core.checkout_session cs WHERE cs.id = commit_purchase.session_id),
         ARRAY['creator_threshold_paise'], 1000000000) THEN
      INSERT INTO core.creator_route_evidence (user_id, route, evidence_order_group_id)
      VALUES (actor, 'SPEND', (receipt ->> 'orderGroupId')::uuid) ON CONFLICT DO NOTHING;
      SET CONSTRAINTS ALL IMMEDIATE;
      SET CONSTRAINTS ALL DEFERRED;
    END IF;
    UPDATE core.idempotency_record r SET status = 200, response = receipt
     WHERE r.user_id = actor AND r.command = 'pay' AND r.key = idempotency_key;
    RETURN jsonb_build_object('status', 'SUCCEEDED', 'replayed', false, 'receipt', receipt, 'reversed', false);
  EXCEPTION WHEN SQLSTATE 'DM001' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT, code = PG_EXCEPTION_HINT;
    IF code = 'PAYMENT_PENDING' THEN
      RAISE;   -- retryable once the challenge is complete
    END IF;
  END;
  -- a validation failure: nothing of the purchase remains; record it
  UPDATE core.idempotency_record r
     SET status = 422, response = jsonb_build_object('error', jsonb_build_object('code', code, 'message', msg))
   WHERE r.user_id = actor AND r.command = 'pay' AND r.key = idempotency_key;
  UPDATE core.payment_attempt pa SET state = 'FAILED', failure_code = code
   WHERE pa.id = commit_purchase.attempt_id AND pa.session_id = commit_purchase.session_id
     AND pa.user_id = actor AND pa.state = 'PENDING';
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  RETURN jsonb_build_object('status', 'FAILED', 'replayed', false,
                            'error', jsonb_build_object('code', code, 'message', msg));
END $$;

-- ---------------------------------------------------------------- privileges
REVOKE ALL ON FUNCTION core.passport_rule_version(), core.passport_complete(uuid, text), core.assert_route_evidence(),
  core.guard_route_evidence(), core.guard_passport_progress(), core.progression_actor(), core.published_saves(uuid),
  core.passport_evaluate(uuid), core.passport_json(uuid), core.save_product(uuid), core.unsave_product(uuid),
  core.my_saves(uuid, int), core.passport_progress(), core.passport_record_quiz(boolean, text),
  core.passport_submit_concept(text, text), core.creator_access() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.save_product(uuid), core.unsave_product(uuid), core.my_saves(uuid, int),
  core.passport_progress(), core.passport_record_quiz(boolean, text), core.passport_submit_concept(text, text),
  core.creator_access() TO app_web;
