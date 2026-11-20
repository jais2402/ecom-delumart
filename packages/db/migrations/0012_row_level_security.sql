-- LLD §2: row-level security on every table in core, ledger, private, analytics,
-- audit, sandbox and research.
--
-- The data-access layer sets app.user_id and app.company_id (transaction-local) on
-- every transaction; core.app_user_id() / core.app_company_id() read them and return
-- NULL when unset, so a request without them matches no owner rows (fails closed).
-- app.company_id is set only after the server confirmed the actor owns the company.
--
-- Every policy names its roles (TO ...): a role with no policy on a table sees no
-- rows even if it is granted access. app_jobs (no user context) gets explicit
-- all-rows policies where background jobs need them; its grants (0011) still limit
-- the commands and columns. npc_worker gets sandbox plus published product versions.
--
-- FORCE ROW LEVEL SECURITY is deliberately not used: the tables are owned by the
-- migration role, which must keep seeing every row for migrations and for the
-- SECURITY DEFINER integrity functions. No application role owns a table or has
-- BYPASSRLS (asserted in tests/hardening.test.ts).

ALTER TABLE core.config_version      ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.system_switch       ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.fictional_locality  ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.fictional_landmark  ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.user_profile        ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.company             ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.identity_tombstone  ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.bank_account        ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.virtual_card        ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.checkout_session    ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.payment_attempt     ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.payment_challenge   ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.idempotency_record  ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.product             ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.product_version     ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.warehouse           ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.inventory_unit      ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.order_group         ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.seller_order        ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.order_line          ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.ownership           ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.shipment            ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.promo_campaign      ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.coupon              ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.coupon_redemption   ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.membership          ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.ledger_account    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.journal           ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.posting           ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.wallet            ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.grant_record      ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.user_secret      ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.address          ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.outbox             ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.consumer_receipt   ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.audit_log          ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.pending_action     ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.event          ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.event_default  ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.metric_daily   ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.metric_hourly  ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.experiment     ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.experiment_exposure ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox.npc_actor        ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox.simulation_run   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox.simulation_order ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------- definer helpers
-- Narrow, read-only questions answered across RLS boundaries. Owned by the
-- migration role; EXECUTE is granted explicitly below (revoked from PUBLIC in 0011
-- and again here because these are created after it).

-- Does either fingerprint match an unexpired tombstone of its kind? Lets provisioning
-- apply the tombstone rule without app_web being able to read or list tombstones.
CREATE FUNCTION core.identity_is_tombstoned(email_fingerprint bytea, phone_fingerprint bytea) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM core.identity_tombstone t
     WHERE t.expires_at > now()
       AND ((t.kind = 'EMAIL' AND t.fingerprint = email_fingerprint)
         OR (t.kind = 'PHONE' AND t.fingerprint = phone_fingerprint)))
$$;

-- Is this the current version of a PUBLISHED product? Used by the product_version
-- policies, including npc_worker's, which has no access to core.product itself.
CREATE FUNCTION core.is_published_version(version_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM core.product p
     WHERE p.current_version_id = version_id AND p.status = 'PUBLISHED')
$$;

REVOKE ALL ON FUNCTION core.identity_is_tombstoned(bytea, bytea), core.is_published_version(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.identity_is_tombstoned(bytea, bytea) TO app_web, app_pay, app_jobs;
GRANT EXECUTE ON FUNCTION core.is_published_version(uuid) TO app_web, app_pay, app_jobs, npc_worker;

-- ---------------------------------------------------------------- app_jobs: all rows
-- Background jobs act on behalf of no single user. Grants (0011) decide which
-- commands and columns each table allows them.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'core.config_version', 'core.system_switch', 'core.fictional_locality', 'core.fictional_landmark',
    'core.user_profile', 'core.company', 'core.bank_account', 'core.virtual_card',
    'core.checkout_session', 'core.payment_attempt', 'core.payment_challenge', 'core.idempotency_record',
    'core.product', 'core.product_version', 'core.warehouse', 'core.inventory_unit',
    'core.order_group', 'core.seller_order', 'core.order_line', 'core.ownership', 'core.shipment',
    'core.promo_campaign', 'core.coupon', 'core.coupon_redemption', 'core.membership',
    'ledger.ledger_account', 'ledger.journal', 'ledger.posting', 'ledger.wallet', 'ledger.grant_record',
    'audit.outbox', 'audit.consumer_receipt', 'audit.audit_log', 'audit.pending_action',
    'analytics.event', 'analytics.event_default', 'analytics.metric_daily', 'analytics.metric_hourly',
    'analytics.experiment', 'analytics.experiment_exposure'
  ] LOOP
    EXECUTE format('CREATE POLICY jobs_all ON %s TO app_jobs USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- tombstones: the deletion job writes and reads them; only expired ones may be purged
CREATE POLICY jobs_read ON core.identity_tombstone FOR SELECT TO app_jobs USING (true);
CREATE POLICY jobs_insert ON core.identity_tombstone FOR INSERT TO app_jobs WITH CHECK (true);
CREATE POLICY jobs_purge_expired ON core.identity_tombstone FOR DELETE TO app_jobs USING (expires_at <= now());

-- ---------------------------------------------------------------- public reference data
CREATE POLICY web_read ON core.config_version     FOR SELECT TO app_web USING (true);
CREATE POLICY web_read ON core.system_switch      FOR SELECT TO app_web USING (true);
CREATE POLICY web_read ON core.fictional_locality FOR SELECT TO app_web USING (true);
CREATE POLICY web_read ON core.fictional_landmark FOR SELECT TO app_web USING (true);
CREATE POLICY pay_read ON core.config_version     FOR SELECT TO app_pay USING (true);
CREATE POLICY pay_read ON core.system_switch      FOR SELECT TO app_pay USING (true);

-- ---------------------------------------------------------------- identity
-- Own row only; public handle lookups will go through a dedicated view.
CREATE POLICY web_own_read ON core.user_profile FOR SELECT TO app_web
  USING (id = core.app_user_id());
CREATE POLICY web_own_update ON core.user_profile FOR UPDATE TO app_web
  USING (id = core.app_user_id()) WITH CHECK (id = core.app_user_id());
-- a user creates only their own profile, and only as an ordinary active player
CREATE POLICY web_own_insert ON core.user_profile FOR INSERT TO app_web
  WITH CHECK (id = core.app_user_id() AND role = 'PLAYER' AND NOT is_test_account AND status = 'ACTIVE');
-- provisioning (app_pay): own profile only; role, test flag and status are not insertable (0011)
CREATE POLICY pay_own_read ON core.user_profile FOR SELECT TO app_pay USING (id = core.app_user_id());
CREATE POLICY pay_own_insert ON core.user_profile FOR INSERT TO app_pay WITH CHECK (id = core.app_user_id());
CREATE POLICY pay_own_update ON core.user_profile FOR UPDATE TO app_pay
  USING (id = core.app_user_id()) WITH CHECK (id = core.app_user_id());

-- company names are storefront data; only the owner creates or renames one
CREATE POLICY web_read ON core.company FOR SELECT TO app_web USING (true);
CREATE POLICY web_owner_insert ON core.company FOR INSERT TO app_web
  WITH CHECK (owner_user_id = core.app_user_id());
CREATE POLICY web_owner_update ON core.company FOR UPDATE TO app_web
  USING (owner_user_id = core.app_user_id()) WITH CHECK (owner_user_id = core.app_user_id());
-- pay locks the selling companies (LLD §4 #4) as app_pay with SELECT ... FOR UPDATE,
-- which applies this policy's USING clause: only companies that have a published
-- product. WITH CHECK (false) makes every real UPDATE by app_pay fail, so the UPDATE
-- privilege (0011) is usable for locking only. app_web can lock only its own company.
CREATE POLICY pay_read ON core.company FOR SELECT TO app_pay USING (true);
CREATE POLICY pay_lock_seller ON core.company FOR UPDATE TO app_pay
  USING (EXISTS (SELECT 1 FROM core.product p WHERE p.company_id = company.id AND p.status = 'PUBLISHED'))
  WITH CHECK (false);

-- ---------------------------------------------------------------- owner-scoped (user_id column)
-- app_web: own rows, read-only except its own secrets and addresses (grants in 0011).
-- app_pay: own rows for the money commands; its grants decide which commands apply.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('core.bank_account',       'user_id',       false, true),
      ('core.virtual_card',       'user_id',       false, true),
      ('core.checkout_session',   'user_id',       false, true),
      ('core.payment_attempt',    'user_id',       false, true),
      ('core.idempotency_record', 'user_id',       false, true),
      ('core.order_group',        'buyer_user_id', false, true),
      ('core.ownership',          'user_id',       false, true),
      ('core.membership',         'user_id',       false, true),
      ('core.coupon_redemption',  'user_id',       false, true),
      ('ledger.grant_record',     'user_id',       false, true),
      ('private.user_secret',     'user_id',       true,  false),
      ('private.address',         'user_id',       true,  false)
    ) AS v(tbl, col, web_writes, pay)
  LOOP
    IF t.web_writes THEN
      EXECUTE format(
        'CREATE POLICY web_owner ON %s TO app_web USING (%I = core.app_user_id()) WITH CHECK (%I = core.app_user_id())',
        t.tbl, t.col, t.col);
    ELSE
      EXECUTE format('CREATE POLICY web_owner ON %s FOR SELECT TO app_web USING (%I = core.app_user_id())',
        t.tbl, t.col);
    END IF;
    IF t.pay THEN
      EXECUTE format(
        'CREATE POLICY pay_owner ON %s TO app_pay USING (%I = core.app_user_id()) WITH CHECK (%I = core.app_user_id())',
        t.tbl, t.col, t.col);
    END IF;
  END LOOP;
END $$;
CREATE POLICY pay_owner_read ON private.address FOR SELECT TO app_pay USING (user_id = core.app_user_id());

-- A bank account is opened on the user's own ledger account, and a card on the user's
-- own bank account (restrictive: ANDed with pay_owner).
CREATE POLICY pay_own_ledger_account ON core.bank_account AS RESTRICTIVE FOR INSERT TO app_pay
  WITH CHECK (EXISTS (SELECT 1 FROM ledger.ledger_account a
                       WHERE a.id = ledger_account_id AND a.type = 'USER' AND a.user_id = core.app_user_id()));
CREATE POLICY pay_own_bank_account ON core.virtual_card AS RESTRICTIVE FOR INSERT TO app_pay
  WITH CHECK (EXISTS (SELECT 1 FROM core.bank_account b
                       WHERE b.id = bank_account_id AND b.user_id = core.app_user_id()));

-- challenges belong to the user through their payment attempt (itself owner-scoped)
CREATE POLICY web_owner ON core.payment_challenge FOR SELECT TO app_web
  USING (EXISTS (SELECT 1 FROM core.payment_attempt a WHERE a.id = attempt_id));
CREATE POLICY pay_owner ON core.payment_challenge TO app_pay
  USING (EXISTS (SELECT 1 FROM core.payment_attempt a WHERE a.id = attempt_id))
  WITH CHECK (EXISTS (SELECT 1 FROM core.payment_attempt a WHERE a.id = attempt_id));

-- ---------------------------------------------------------------- orders: buyer and seller sides
CREATE POLICY seller_order_parties ON core.seller_order FOR SELECT TO app_web
  USING (buyer_user_id = core.app_user_id() OR company_id = core.app_company_id());
-- seller orders, lines and shipments are created inside the buyer's pay transaction (app_pay)
CREATE POLICY pay_buyer ON core.seller_order TO app_pay
  USING (buyer_user_id = core.app_user_id()) WITH CHECK (buyer_user_id = core.app_user_id());

-- lines and shipments follow their seller order (visible to buyer or seller company)
CREATE POLICY order_line_parties ON core.order_line FOR SELECT TO app_web
  USING (EXISTS (SELECT 1 FROM core.seller_order so WHERE so.id = seller_order_id));
CREATE POLICY pay_buyer ON core.order_line TO app_pay
  USING (EXISTS (SELECT 1 FROM core.seller_order so WHERE so.id = seller_order_id))
  WITH CHECK (EXISTS (SELECT 1 FROM core.seller_order so
                       WHERE so.id = seller_order_id AND so.buyer_user_id = core.app_user_id()));
CREATE POLICY shipment_parties ON core.shipment FOR SELECT TO app_web
  USING (EXISTS (SELECT 1 FROM core.seller_order so WHERE so.id = seller_order_id));
CREATE POLICY pay_buyer ON core.shipment TO app_pay
  USING (EXISTS (SELECT 1 FROM core.seller_order so WHERE so.id = seller_order_id))
  WITH CHECK (EXISTS (SELECT 1 FROM core.seller_order so
                       WHERE so.id = seller_order_id AND so.buyer_user_id = core.app_user_id()));

-- ---------------------------------------------------------------- catalog and inventory
-- Buyers see published products and products they own; a company sees its own.
CREATE POLICY web_read ON core.product FOR SELECT TO app_web
  USING (status = 'PUBLISHED'
      OR company_id = core.app_company_id()
      OR EXISTS (SELECT 1 FROM core.ownership o WHERE o.product_id = product.id));
CREATE POLICY web_company_insert ON core.product FOR INSERT TO app_web
  WITH CHECK (seller_type = 'USER' AND company_id = core.app_company_id() AND status = 'DRAFT');
-- the company moves its own listings (submit); the column grant limits this to status
CREATE POLICY web_update ON core.product FOR UPDATE TO app_web
  USING (company_id = core.app_company_id())
  WITH CHECK (company_id = core.app_company_id());
-- app_pay: reads published products (and ones the buyer owns); issues stock of, and so
-- locks, published products only (column grant: available_units)
CREATE POLICY pay_read ON core.product FOR SELECT TO app_pay
  USING (status = 'PUBLISHED' OR EXISTS (SELECT 1 FROM core.ownership o WHERE o.product_id = product.id));
CREATE POLICY pay_issue ON core.product FOR UPDATE TO app_pay
  USING (status = 'PUBLISHED') WITH CHECK (status = 'PUBLISHED');

CREATE POLICY web_read ON core.product_version FOR SELECT TO app_web
  USING (core.is_published_version(id)
      OR EXISTS (SELECT 1 FROM core.product p WHERE p.id = product_id AND p.company_id = core.app_company_id()));
CREATE POLICY web_company_insert ON core.product_version FOR INSERT TO app_web
  WITH CHECK (EXISTS (SELECT 1 FROM core.product p WHERE p.id = product_id AND p.company_id = core.app_company_id()));
CREATE POLICY npc_published ON core.product_version FOR SELECT TO npc_worker
  USING (core.is_published_version(id));
CREATE POLICY pay_published ON core.product_version FOR SELECT TO app_pay
  USING (core.is_published_version(id));

-- units follow their (visible) product
CREATE POLICY web_visible_product ON core.inventory_unit FOR SELECT TO app_web
  USING (EXISTS (SELECT 1 FROM core.product p WHERE p.id = product_id));
-- the pay transaction (app_pay) issues AVAILABLE units of published products, and can
-- only move them to ISSUED with an order line (never back, never to other states)
CREATE POLICY pay_read ON core.inventory_unit FOR SELECT TO app_pay
  USING (EXISTS (SELECT 1 FROM core.product p WHERE p.id = product_id));
CREATE POLICY pay_issue ON core.inventory_unit FOR UPDATE TO app_pay
  USING (state = 'AVAILABLE' AND EXISTS (SELECT 1 FROM core.product p WHERE p.id = product_id AND p.status = 'PUBLISHED'))
  WITH CHECK (state = 'ISSUED' AND order_line_id IS NOT NULL);
-- warehouses: the company's own, or ones holding units of visible products
CREATE POLICY web_read ON core.warehouse FOR SELECT TO app_web
  USING (company_id = core.app_company_id()
      OR EXISTS (SELECT 1 FROM core.inventory_unit u WHERE u.warehouse_id = warehouse.id));
-- app_pay locks and decrements `used` (column grant) of warehouses holding AVAILABLE
-- units of published products
CREATE POLICY pay_read ON core.warehouse FOR SELECT TO app_pay
  USING (EXISTS (SELECT 1 FROM core.inventory_unit u WHERE u.warehouse_id = warehouse.id));
CREATE POLICY pay_issue ON core.warehouse FOR UPDATE TO app_pay
  USING (EXISTS (SELECT 1 FROM core.inventory_unit u JOIN core.product p ON p.id = u.product_id
                  WHERE u.warehouse_id = warehouse.id AND p.status = 'PUBLISHED'))
  WITH CHECK (true);

-- ---------------------------------------------------------------- promotions
-- Coupons are redeemed by code inside pay (cap counter); merchants create their own.
CREATE POLICY web_read ON core.coupon FOR SELECT TO app_web USING (status = 'ACTIVE' OR company_id = core.app_company_id());
CREATE POLICY web_company_insert ON core.coupon FOR INSERT TO app_web
  WITH CHECK (scope = 'MERCHANT' AND company_id = core.app_company_id());
-- the cap counter moves only in pay (app_pay) and must equal the redemptions (0016)
CREATE POLICY pay_read ON core.coupon FOR SELECT TO app_pay USING (status = 'ACTIVE');
CREATE POLICY pay_redeem ON core.coupon FOR UPDATE TO app_pay USING (status = 'ACTIVE') WITH CHECK (status = 'ACTIVE');
CREATE POLICY web_active ON core.promo_campaign FOR SELECT TO app_web USING (status = 'ACTIVE');

-- ---------------------------------------------------------------- ledger
-- A user's own USER account; MINT and SINK rows (no personal data) are readable.
-- app_web reads only; app_pay creates the user's own account at provisioning.
CREATE POLICY web_read ON ledger.ledger_account FOR SELECT TO app_web
  USING (user_id = core.app_user_id() OR type <> 'USER');
-- pay must credit sellers, so app_pay may also see the USER account id of the owner of
-- a company that has a published product (an id only; it cannot read that account's
-- postings or wallet, and 0016 forbids debiting any account but the actor's own).
CREATE POLICY pay_read ON ledger.ledger_account FOR SELECT TO app_pay
  USING (user_id = core.app_user_id() OR type <> 'USER'
      OR EXISTS (SELECT 1 FROM core.company c JOIN core.product p ON p.company_id = c.id
                  WHERE c.owner_user_id = ledger_account.user_id AND p.status = 'PUBLISHED'));
CREATE POLICY pay_own_insert ON ledger.ledger_account FOR INSERT TO app_pay
  WITH CHECK (type = 'USER' AND user_id = core.app_user_id());

-- Postings: the user's transactions post to other accounts (seller, MINT, SINK), so
-- app_pay inserts are open here and governed by the integrity triggers (0003, 0014,
-- 0016); reads are own-account.
CREATE POLICY web_own_read ON ledger.posting FOR SELECT TO app_web
  USING (account_id IN (SELECT a.id FROM ledger.ledger_account a
                         WHERE a.type = 'USER' AND a.user_id = core.app_user_id()));
CREATE POLICY pay_own_read ON ledger.posting FOR SELECT TO app_pay
  USING (account_id IN (SELECT a.id FROM ledger.ledger_account a
                         WHERE a.type = 'USER' AND a.user_id = core.app_user_id()));
CREATE POLICY pay_insert ON ledger.posting FOR INSERT TO app_pay WITH CHECK (true);

-- Journals: readable when they touch the user's account (posting policy applies inside).
-- app_pay's journal-type insert policy is in 0014.
CREATE POLICY web_own_read ON ledger.journal FOR SELECT TO app_web
  USING (EXISTS (SELECT 1 FROM ledger.posting p WHERE p.journal_id = journal.id));
CREATE POLICY pay_own_read ON ledger.journal FOR SELECT TO app_pay
  USING (EXISTS (SELECT 1 FROM ledger.posting p WHERE p.journal_id = journal.id));

-- Wallets: own only. Other parties' wallets are brought in line through
-- ledger.sync_wallets(), which can only make a wallet equal its postings.
CREATE POLICY web_owner ON ledger.wallet FOR SELECT TO app_web
  USING (account_id IN (SELECT a.id FROM ledger.ledger_account a
                         WHERE a.type = 'USER' AND a.user_id = core.app_user_id()));
CREATE POLICY pay_owner ON ledger.wallet TO app_pay
  USING (account_id IN (SELECT a.id FROM ledger.ledger_account a
                         WHERE a.type = 'USER' AND a.user_id = core.app_user_id()))
  WITH CHECK (account_id IN (SELECT a.id FROM ledger.ledger_account a
                              WHERE a.type = 'USER' AND a.user_id = core.app_user_id()));

-- ---------------------------------------------------------------- audit and analytics: append-only for the web
CREATE POLICY web_append ON audit.outbox      FOR INSERT TO app_web WITH CHECK (true);
CREATE POLICY pay_append ON audit.outbox      FOR INSERT TO app_pay WITH CHECK (true);
CREATE POLICY web_append ON audit.audit_log   FOR INSERT TO app_web WITH CHECK (true);
CREATE POLICY web_append ON analytics.event   FOR INSERT TO app_web WITH CHECK (true);

-- pending admin actions: only the Super Admin, for actions they requested
CREATE POLICY web_super_admin ON audit.pending_action TO app_web
  USING (EXISTS (SELECT 1 FROM core.user_profile p WHERE p.id = core.app_user_id() AND p.role = 'SUPER_ADMIN'))
  WITH CHECK (requested_by = core.app_user_id()
          AND EXISTS (SELECT 1 FROM core.user_profile p WHERE p.id = core.app_user_id() AND p.role = 'SUPER_ADMIN'));

-- experiments: running ones are needed for assignment; exposures are the user's own
CREATE POLICY web_running ON analytics.experiment FOR SELECT TO app_web USING (status = 'RUNNING');
CREATE POLICY web_own ON analytics.experiment_exposure TO app_web
  USING (subject_id = core.app_user_id()) WITH CHECK (subject_id = core.app_user_id());

-- ---------------------------------------------------------------- sandbox: NPC role only
CREATE POLICY npc_all ON sandbox.npc_actor        TO npc_worker USING (true) WITH CHECK (true);
CREATE POLICY npc_all ON sandbox.simulation_run   TO npc_worker USING (true) WITH CHECK (true);
CREATE POLICY npc_all ON sandbox.simulation_order TO npc_worker USING (true) WITH CHECK (true);
