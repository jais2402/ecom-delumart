-- Checkout and pay (LLD §5.2): the creator entitlement (§3.9, §5.8) and the one
-- narrow cross-RLS helper the buyer's pay transaction needs.

-- ---------------------------------------------------------------- creator entitlement (minimal)
CREATE TABLE core.creator_entitlement (
  id                      uuid PRIMARY KEY,
  user_id                 uuid NOT NULL UNIQUE REFERENCES core.user_profile(id),
  source                  text NOT NULL CHECK (source IN ('PURCHASE_THRESHOLD')),
  evidence_order_group_id uuid REFERENCES core.order_group(id),
  unlocked_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (source <> 'PURCHASE_THRESHOLD' OR evidence_order_group_id IS NOT NULL)
);

ALTER TABLE core.creator_entitlement ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON core.creator_entitlement TO app_web;   -- inserted in the pay transaction
GRANT SELECT ON core.creator_entitlement TO app_jobs;

CREATE POLICY jobs_all ON core.creator_entitlement TO app_jobs USING (true) WITH CHECK (true);
CREATE POLICY web_owner_read ON core.creator_entitlement FOR SELECT TO app_web
  USING (user_id = core.app_user_id());
-- The web role may record only its own unlock, with one of its own order groups as
-- evidence, and only while its wallet is strictly below that order's configured
-- creator threshold (US-04). A user cannot grant themselves the entitlement otherwise.
CREATE POLICY web_owner_insert ON core.creator_entitlement FOR INSERT TO app_web
  WITH CHECK (
    creator_entitlement.user_id = core.app_user_id()
    AND creator_entitlement.source = 'PURCHASE_THRESHOLD'
    AND EXISTS (
      SELECT 1
        FROM core.order_group g
        JOIN core.config_version cv ON cv.id = g.config_version
        JOIN ledger.ledger_account a ON a.user_id = g.buyer_user_id AND a.type = 'USER'
        JOIN ledger.wallet w ON w.account_id = a.id
       WHERE g.id = creator_entitlement.evidence_order_group_id
         AND g.buyer_user_id = creator_entitlement.user_id
         AND w.available_paise < COALESCE((cv.values->>'creator_threshold_paise')::bigint, 1000000000)));

-- ---------------------------------------------------------------- selling companies (pay lock #4)
-- The buyer's pay transaction must lock the selling companies (LLD §4 #4) and post
-- each seller's proceeds to the owner's ledger account. Under RLS app_web can neither
-- lock another user's company row (SELECT ... FOR UPDATE needs the owner-only UPDATE
-- policy) nor read another user's ledger account. This definer function does both
-- for companies that currently have a PUBLISHED product, in ascending id order, and
-- returns only ids: the company, its owner and the owner's USER ledger account.
CREATE FUNCTION core.lock_selling_companies(company_ids uuid[])
RETURNS TABLE (company_id uuid, owner_user_id uuid, ledger_account_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.id, c.owner_user_id, la.id
    FROM core.company c
    LEFT JOIN ledger.ledger_account la ON la.user_id = c.owner_user_id AND la.type = 'USER'
   WHERE c.id = ANY(company_ids)
     AND EXISTS (SELECT 1 FROM core.product p WHERE p.company_id = c.id AND p.status = 'PUBLISHED')
   ORDER BY c.id
   FOR UPDATE OF c
$$;
REVOKE ALL ON FUNCTION core.lock_selling_companies(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.lock_selling_companies(uuid[]) TO app_web;
