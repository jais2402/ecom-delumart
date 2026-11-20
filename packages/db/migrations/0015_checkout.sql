-- Checkout and pay (LLD §5.2): the creator entitlement (§3.9, §5.8).
--
-- The pay transaction runs as app_pay (0011). It locks the selling companies
-- (LLD §4 #4) directly through the pay_lock_seller policy (0012) and reads each
-- seller's ledger account id through pay_read on ledger.ledger_account; there is no
-- definer helper for it, so app_web has no way to take those locks.

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

GRANT SELECT ON core.creator_entitlement TO app_web;
GRANT SELECT, INSERT (id, user_id, source, evidence_order_group_id) ON core.creator_entitlement TO app_pay;   -- in pay
GRANT SELECT ON core.creator_entitlement TO app_jobs;

CREATE POLICY jobs_all ON core.creator_entitlement TO app_jobs USING (true) WITH CHECK (true);
CREATE POLICY web_owner_read ON core.creator_entitlement FOR SELECT TO app_web
  USING (user_id = core.app_user_id());
CREATE POLICY pay_owner_read ON core.creator_entitlement FOR SELECT TO app_pay
  USING (user_id = core.app_user_id());
-- The pay role may record only its own unlock, with one of its own order groups as
-- evidence, and only while its wallet is strictly below that order's configured
-- creator threshold (US-04). 0016 re-checks this at commit and requires the evidence
-- order group to be created in the same transaction.
CREATE POLICY pay_owner_insert ON core.creator_entitlement FOR INSERT TO app_pay
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
