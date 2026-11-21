-- Submission cap bypass (sixth security review, major 2). The `listing_submissions_per_day` (10)
-- cap counted core.listing_submission rows, which core.draft_delete removes with the draft: create,
-- submit, get rejected, delete, repeat — and the cap never filled. Submissions are now counted in
-- an append-only log that nothing deletes or changes (no product foreign key, so deleting the draft
-- leaves its entries). core.listing_open_submission writes one entry per submission and counts
-- the log under the company's row lock (LLD §4 #4, held by every caller).

CREATE TABLE core.listing_submission_log (
  submission_id uuid PRIMARY KEY,
  company_id    uuid NOT NULL REFERENCES core.company (id),
  product_id    uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('FIRST', 'REVISION')),
  submitted_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX listing_submission_log_company_day ON core.listing_submission_log (company_id, submitted_at);
ALTER TABLE core.listing_submission_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.listing_submission_log
  FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;
CREATE POLICY owner_only ON core.listing_submission_log USING (false) WITH CHECK (false);
CREATE TRIGGER no_update BEFORE UPDATE ON core.listing_submission_log
  FOR EACH ROW EXECUTE FUNCTION core.refuse_change();
CREATE TRIGGER no_delete BEFORE DELETE ON core.listing_submission_log
  FOR EACH ROW EXECUTE FUNCTION core.refuse_delete();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON core.listing_submission_log
  FOR EACH STATEMENT EXECUTE FUNCTION core.refuse_delete();

-- what was submitted before this migration still counts
INSERT INTO core.listing_submission_log (submission_id, company_id, product_id, kind, submitted_at)
SELECT s.id, s.company_id, s.product_id, s.kind, s.submitted_at FROM core.listing_submission s;

CREATE OR REPLACE FUNCTION core.listing_submissions_today(p_company uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT count(*) FROM core.listing_submission_log l
   WHERE l.company_id = p_company
     AND l.submitted_at >= (date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
$$;

CREATE OR REPLACE FUNCTION core.listing_open_submission(p_product uuid, p_version uuid, p_company uuid, p_kind text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_id uuid := core.uuid_v7();
BEGIN
  -- #4 the company: the daily cap is counted under its lock (callers already hold it)
  PERFORM 1 FROM core.company c WHERE c.id = p_company FOR NO KEY UPDATE;
  IF core.listing_submissions_today(p_company) >= core.listing_cap('listing_submissions_per_day', 10) THEN
    PERFORM core.fail('SUBMISSION_LIMIT', 'your store has made its submissions for today (UTC); try again tomorrow');
  END IF;
  INSERT INTO core.listing_submission (id, product_id, version_id, company_id, kind, state)
  VALUES (v_id, p_product, p_version, p_company, p_kind, 'SCREENING');
  INSERT INTO core.listing_submission_log (submission_id, company_id, product_id, kind)
  VALUES (v_id, p_company, p_product, p_kind);
  -- ids only (invariant 8)
  INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
  VALUES (core.uuid_v7(), 'listing_submitted', p_product, jsonb_build_object(
    'productId', p_product, 'versionId', p_version, 'submissionId', v_id, 'companyId', p_company, 'kind', p_kind), 1);
  RETURN v_id;
END $$;
