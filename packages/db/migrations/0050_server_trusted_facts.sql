-- Facts the database took on the web server's word (sixth security review, minor 7).
--
-- (a) The passport quiz is graded HERE. The answer key of rule version passport_v1 lives in an
--     owner-only table (core.passport_answer_key, seeded below; a test keeps it equal to
--     packages/core/src/passport). core.passport_submit_quiz(answers jsonb) grades the answers
--     ({questionId: optionId}) under the current rule version, records a pass or a failed try
--     exactly as before, and returns {passed, wrong: [questionId, ...] in question order,
--     ruleVersion, passport}. No application role may execute core.passport_record_quiz any more.
-- (b) The commands that store public or reviewable text on the strength of the web server's
--     screening verdict — core.passport_submit_concept, core.company_quote (already), core.update_store,
--     core.report_create (the detail and its flags) and core.appeal_create (the statement) — are
--     executable by app_pay only: an injected query on the ordinary (app_web) pool can no longer
--     store unscreened text. The routes call them through the pay pool.
-- (c) core.company.owner_user_id is unreadable by every application role (column privileges): a
--     store cannot be linked to its owner's user id. core.actor_company_ids(), which the row-level
--     security policies use, reads it as the owner (SECURITY DEFINER) and answers only the actor's
--     own companies.

-- ---------------------------------------------------------------- (a) the quiz
CREATE TABLE core.passport_answer_key (
  rule_version      text NOT NULL CHECK (rule_version ~ '^passport_v[0-9]+$'),
  question_id       text NOT NULL CHECK (char_length(question_id) BETWEEN 1 AND 64),
  ordinal           int NOT NULL CHECK (ordinal >= 1),
  correct_option_id text NOT NULL CHECK (char_length(correct_option_id) BETWEEN 1 AND 64),
  PRIMARY KEY (rule_version, question_id),
  UNIQUE (rule_version, ordinal)
);
ALTER TABLE core.passport_answer_key ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.passport_answer_key FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;
CREATE POLICY owner_only ON core.passport_answer_key USING (false) WITH CHECK (false);

INSERT INTO core.passport_answer_key (rule_version, question_id, ordinal, correct_option_id) VALUES
  ('passport_v1', 'q-money', 1, 'opt-money-play'),
  ('passport_v1', 'q-delivery', 2, 'opt-delivery-sim'),
  ('passport_v1', 'q-buyers', 3, 'opt-buyers-sim');

CREATE FUNCTION core.passport_submit_quiz(answers jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor  uuid := core.progression_actor();
  rv     text := core.passport_rule_version();
  wrong  text[];
  passed boolean;
BEGIN
  IF answers IS NULL OR jsonb_typeof(answers) <> 'object' THEN
    PERFORM core.fail('VALIDATION_FAILED', 'answers are {questionId: optionId}');
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(answers)) > 20 OR EXISTS (
       SELECT 1 FROM jsonb_each(answers) e
        WHERE char_length(e.key) NOT BETWEEN 1 AND 64 OR jsonb_typeof(e.value) <> 'string'
           OR char_length(e.value #>> '{}') NOT BETWEEN 1 AND 64) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'answers are {questionId: optionId}');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.passport_answer_key k WHERE k.rule_version = rv) THEN
    RAISE EXCEPTION 'passport: no answer key for %', rv USING ERRCODE = 'internal_error';
  END IF;
  SELECT COALESCE(array_agg(k.question_id ORDER BY k.ordinal), '{}') INTO wrong
    FROM core.passport_answer_key k
   WHERE k.rule_version = rv AND (answers ->> k.question_id) IS DISTINCT FROM k.correct_option_id;
  passed := cardinality(wrong) = 0;

  INSERT INTO core.passport_progress (user_id, rule_version) VALUES (actor, rv) ON CONFLICT (user_id) DO NOTHING;
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
  RETURN jsonb_build_object('passed', passed, 'wrong', to_jsonb(wrong), 'ruleVersion', rv,
                            'passport', core.passport_json(actor));
END $$;
REVOKE ALL ON FUNCTION core.passport_submit_quiz(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.passport_submit_quiz(jsonb) TO app_web;
REVOKE ALL ON FUNCTION core.passport_record_quiz(boolean, text)
  FROM PUBLIC, app_web, app_pay, app_jobs, npc_worker, research_ro;

-- ---------------------------------------------------------------- (b) screened text: app_pay only
REVOKE ALL ON FUNCTION core.passport_submit_concept(text, text), core.update_store(text, text),
  core.report_create(text, uuid, text, text, jsonb), core.appeal_create(uuid, text)
  FROM PUBLIC, app_web, app_jobs, npc_worker, research_ro;
GRANT EXECUTE ON FUNCTION core.passport_submit_concept(text, text), core.update_store(text, text),
  core.report_create(text, uuid, text, text, jsonb), core.appeal_create(uuid, text)
TO app_pay;

-- ---------------------------------------------------------------- (c) no owner id for the application
ALTER FUNCTION core.actor_company_ids() SECURITY DEFINER;
ALTER FUNCTION core.actor_company_ids() SET search_path = pg_catalog, pg_temp;
REVOKE SELECT ON core.company FROM app_web, app_pay, app_jobs, npc_worker, research_ro;
GRANT SELECT (id, name, handle, description, tier, created_at, updated_at) ON core.company TO app_web, app_pay;
