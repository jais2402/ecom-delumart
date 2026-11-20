-- LLD §2: row-level security. The data-access layer sets app.user_id and
-- app.company_id (transaction-local) on every transaction. Unset settings read
-- as NULL (missing_ok + nullif), so a request without them sees no rows instead
-- of raising "unrecognized configuration parameter".
-- Policies without TO apply to every non-owner role; app_jobs (no user context)
-- gets an explicit all-rows policy on the core tables it must process.

ALTER TABLE private.address ENABLE ROW LEVEL SECURITY;
CREATE POLICY address_owner ON private.address
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE private.user_secret ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_secret_owner ON private.user_secret
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE core.seller_order ENABLE ROW LEVEL SECURITY;
CREATE POLICY seller_order_parties ON core.seller_order FOR SELECT
  USING (buyer_user_id = nullif(current_setting('app.user_id', true), '')::uuid
      OR company_id    = nullif(current_setting('app.company_id', true), '')::uuid);
-- seller orders are created inside the buyer's pay transaction
CREATE POLICY seller_order_buyer_insert ON core.seller_order FOR INSERT
  WITH CHECK (buyer_user_id = nullif(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY seller_order_jobs ON core.seller_order TO app_jobs USING (true) WITH CHECK (true);

-- owner policies on the user-owned core tables
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('bank_account',     'user_id'),
      ('virtual_card',     'user_id'),
      ('checkout_session', 'user_id'),
      ('payment_attempt',  'user_id'),
      ('order_group',      'buyer_user_id'),
      ('ownership',        'user_id')
    ) AS v(tbl, col)
  LOOP
    EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY', t.tbl);
    EXECUTE format(
      'CREATE POLICY %I ON core.%I USING (%I = nullif(current_setting(''app.user_id'', true), '''')::uuid) '
      'WITH CHECK (%I = nullif(current_setting(''app.user_id'', true), '''')::uuid)',
      t.tbl || '_owner', t.tbl, t.col, t.col);
    EXECUTE format('CREATE POLICY %I ON core.%I TO app_jobs USING (true) WITH CHECK (true)',
      t.tbl || '_jobs', t.tbl);
  END LOOP;
END $$;
