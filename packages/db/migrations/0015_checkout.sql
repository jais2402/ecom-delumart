-- Checkout and pay (LLD §5.2): the creator entitlement (§3.9, §5.8).
--
-- The entitlement is recorded only inside core.commit_purchase (0018), which runs as the
-- owner for the signed-in buyer; no application role inserts it directly.

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

GRANT SELECT ON core.creator_entitlement TO app_web, app_pay, app_jobs;

CREATE POLICY jobs_all ON core.creator_entitlement TO app_jobs USING (true) WITH CHECK (true);
CREATE POLICY web_owner_read ON core.creator_entitlement FOR SELECT TO app_web
  USING (user_id = core.actor_id());
CREATE POLICY pay_owner_read ON core.creator_entitlement FOR SELECT TO app_pay
  USING (user_id = core.actor_id());
