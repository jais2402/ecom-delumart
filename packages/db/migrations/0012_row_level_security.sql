-- LLD §2: row-level security on every table in core, ledger, private, analytics,
-- audit, sandbox and research.
--
-- The data-access layer sets app.session_id (transaction-local) to the caller's sign-in
-- session; core.actor_id() (0001) resolves it to the user of a live session and returns NULL
-- otherwise, so a request without a valid session matches no owner rows (fails closed). The
-- connection never names the user. Company scope is never taken from a setting the connection
-- controls either: a row belongs to the actor's company iff that company's owner_user_id is
-- the acting user (core.actor_company_ids() below).
--
-- app_pay and app_web write nothing on the money path (0011); their policies here are read
-- policies. The command functions of 0018 run as the owner, which RLS does not filter.
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

-- The companies the acting user owns. SECURITY INVOKER and inlinable: every role that uses
-- it can already read core.company (0011). Policies use it as
-- `company_id IN (SELECT core.actor_company_ids())`.
CREATE FUNCTION core.actor_company_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE AS $$
  SELECT c.id FROM core.company c WHERE c.owner_user_id = core.actor_id()
$$;

-- Coupon lookup: the ACTIVE merchant coupon with exactly this normalised code among the given
-- companies, or nothing. Executable by no application role: checkout resolves codes inside the
-- command functions of 0018, among the sellers of the caller's own cart only, and counts failed
-- lookups per actor (at most 10 an hour, LLD §11.2).
CREATE FUNCTION core.find_coupon(p_code text, p_company_ids uuid[]) RETURNS SETOF core.coupon
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.* FROM core.coupon c
   WHERE c.scope = 'MERCHANT' AND c.status = 'ACTIVE' AND c.code_normalised = p_code
     AND c.company_id = ANY(p_company_ids)
   ORDER BY c.id LIMIT 1
$$;

REVOKE ALL ON FUNCTION core.identity_is_tombstoned(bytea, bytea), core.is_published_version(uuid),
  core.actor_company_ids(), core.find_coupon(text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.actor_company_ids() TO app_web, app_pay, app_jobs;
-- tombstones are checked inside core.provision_account; only the jobs may ask directly
GRANT EXECUTE ON FUNCTION core.identity_is_tombstoned(bytea, bytea) TO app_jobs;
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
-- Own row only; public handle lookups will go through a dedicated view. The profile is
-- created only by core.provision_account (0018); no application role writes it.
CREATE POLICY web_own_read ON core.user_profile FOR SELECT TO app_web
  USING (id = core.actor_id());
CREATE POLICY pay_own_read ON core.user_profile FOR SELECT TO app_pay USING (id = core.actor_id());

-- company names are storefront data; only the owner creates or renames one
CREATE POLICY web_read ON core.company FOR SELECT TO app_web USING (true);
CREATE POLICY web_owner_insert ON core.company FOR INSERT TO app_web
  WITH CHECK (owner_user_id = core.actor_id());
CREATE POLICY web_owner_update ON core.company FOR UPDATE TO app_web
  USING (owner_user_id = core.actor_id()) WITH CHECK (owner_user_id = core.actor_id());
-- app_pay reads companies (sellers' owners, for pricing); it holds no UPDATE privilege, so
-- it can lock none. The selling companies are locked inside core.commit_purchase (LLD §4 #4).
-- app_web can lock only its own company.
CREATE POLICY pay_read ON core.company FOR SELECT TO app_pay USING (true);

-- ---------------------------------------------------------------- owner-scoped (user_id column)
-- app_web: own rows, read-only except its own addresses (grants in 0011).
-- app_pay: own rows, read-only (the money commands are the functions of 0018).
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
      ('private.user_secret',     'user_id',       false, false),
      ('private.address',         'user_id',       true,  false)
    ) AS v(tbl, col, web_writes, pay)
  LOOP
    IF t.web_writes THEN
      EXECUTE format(
        'CREATE POLICY web_owner ON %s TO app_web USING (%I = core.actor_id()) WITH CHECK (%I = core.actor_id())',
        t.tbl, t.col, t.col);
    ELSE
      EXECUTE format('CREATE POLICY web_owner ON %s FOR SELECT TO app_web USING (%I = core.actor_id())',
        t.tbl, t.col);
    END IF;
    IF t.pay THEN
      EXECUTE format('CREATE POLICY pay_owner ON %s FOR SELECT TO app_pay USING (%I = core.actor_id())',
        t.tbl, t.col);
    END IF;
  END LOOP;
END $$;
CREATE POLICY pay_owner_read ON private.address FOR SELECT TO app_pay USING (user_id = core.actor_id());

-- challenges belong to the user through their payment attempt (itself owner-scoped)
CREATE POLICY web_owner ON core.payment_challenge FOR SELECT TO app_web
  USING (EXISTS (SELECT 1 FROM core.payment_attempt a WHERE a.id = attempt_id));
CREATE POLICY pay_owner ON core.payment_challenge FOR SELECT TO app_pay
  USING (EXISTS (SELECT 1 FROM core.payment_attempt a WHERE a.id = attempt_id));

-- ---------------------------------------------------------------- orders: buyer and seller sides
-- (app_web cannot select seller_order.buyer_user_id at all, 0011: purchases are anonymous to
-- sellers; the buyer side reads its own order groups)
CREATE POLICY seller_order_parties ON core.seller_order FOR SELECT TO app_web
  USING (buyer_user_id = core.actor_id() OR company_id IN (SELECT core.actor_company_ids()));
-- seller orders, lines and shipments are created inside core.commit_purchase (0018)
CREATE POLICY pay_buyer ON core.seller_order FOR SELECT TO app_pay
  USING (buyer_user_id = core.actor_id());

-- lines and shipments follow their seller order (visible to buyer or seller company)
CREATE POLICY order_line_parties ON core.order_line FOR SELECT TO app_web
  USING (EXISTS (SELECT 1 FROM core.seller_order so WHERE so.id = seller_order_id));
CREATE POLICY pay_buyer ON core.order_line FOR SELECT TO app_pay
  USING (EXISTS (SELECT 1 FROM core.seller_order so WHERE so.id = seller_order_id));
CREATE POLICY shipment_parties ON core.shipment FOR SELECT TO app_web
  USING (EXISTS (SELECT 1 FROM core.seller_order so WHERE so.id = seller_order_id));
CREATE POLICY pay_buyer ON core.shipment FOR SELECT TO app_pay
  USING (EXISTS (SELECT 1 FROM core.seller_order so WHERE so.id = seller_order_id));

-- ---------------------------------------------------------------- catalog and inventory
-- Buyers see published products and products they own; a company owner sees its own.
CREATE POLICY web_read ON core.product FOR SELECT TO app_web
  USING (status = 'PUBLISHED'
      OR company_id IN (SELECT core.actor_company_ids())
      OR EXISTS (SELECT 1 FROM core.ownership o WHERE o.product_id = product.id));
CREATE POLICY web_company_insert ON core.product FOR INSERT TO app_web
  WITH CHECK (seller_type = 'USER' AND status = 'DRAFT' AND company_id IN (SELECT core.actor_company_ids()));
-- the owner moves its own listings; the column grant limits this to status and current
-- version, and the transition trigger (0017) to the moves app_web may make
CREATE POLICY web_update ON core.product FOR UPDATE TO app_web
  USING (company_id IN (SELECT core.actor_company_ids()))
  WITH CHECK (company_id IN (SELECT core.actor_company_ids()));
-- app_pay: reads published products (and ones the buyer owns), for pricing
CREATE POLICY pay_read ON core.product FOR SELECT TO app_pay
  USING (status = 'PUBLISHED' OR EXISTS (SELECT 1 FROM core.ownership o WHERE o.product_id = product.id));

CREATE POLICY web_read ON core.product_version FOR SELECT TO app_web
  USING (core.is_published_version(id)
      OR EXISTS (SELECT 1 FROM core.product p
                  WHERE p.id = product_id AND p.company_id IN (SELECT core.actor_company_ids())));
CREATE POLICY web_company_insert ON core.product_version FOR INSERT TO app_web
  WITH CHECK (EXISTS (SELECT 1 FROM core.product p
                       WHERE p.id = product_id AND p.company_id IN (SELECT core.actor_company_ids())));
CREATE POLICY npc_published ON core.product_version FOR SELECT TO npc_worker
  USING (core.is_published_version(id));
CREATE POLICY pay_published ON core.product_version FOR SELECT TO app_pay
  USING (core.is_published_version(id));

-- units follow their (visible) product
CREATE POLICY web_visible_product ON core.inventory_unit FOR SELECT TO app_web
  USING (EXISTS (SELECT 1 FROM core.product p WHERE p.id = product_id));
-- app_pay reads units of visible products (Zap hub eligibility); units are issued only
-- inside core.commit_purchase
CREATE POLICY pay_read ON core.inventory_unit FOR SELECT TO app_pay
  USING (EXISTS (SELECT 1 FROM core.product p WHERE p.id = product_id));
-- warehouses: the owner's own, or ones holding units of visible products
CREATE POLICY web_read ON core.warehouse FOR SELECT TO app_web
  USING (company_id IN (SELECT core.actor_company_ids())
      OR EXISTS (SELECT 1 FROM core.inventory_unit u WHERE u.warehouse_id = warehouse.id));
CREATE POLICY pay_read ON core.warehouse FOR SELECT TO app_pay
  USING (EXISTS (SELECT 1 FROM core.inventory_unit u WHERE u.warehouse_id = warehouse.id));

-- ---------------------------------------------------------------- promotions
-- Coupons are redeemed by code inside pay (cap counter); company owners create their own through
-- core.create_coupon (0020), which generates every private code: app_web inserts none directly.
-- A private coupon's code is readable only by the owner of its company; everyone else sees
-- public ACTIVE coupons only (a buyer types a private code; it is looked up, not listed).
CREATE POLICY web_read ON core.coupon FOR SELECT TO app_web
  USING (company_id IN (SELECT core.actor_company_ids()) OR (is_public AND status = 'ACTIVE'));
-- app_pay reads public ACTIVE coupons and the ones named in the buyer's own checkout
-- sessions (to price pay); it cannot list private coupons, and codes are looked up only
-- inside the checkout command functions (0018). The cap counter moves only in
-- core.commit_purchase and must equal the redemptions (0016).
CREATE POLICY pay_read ON core.coupon FOR SELECT TO app_pay
  USING (status = 'ACTIVE'
     AND (is_public OR EXISTS (SELECT 1 FROM core.checkout_session s
                                WHERE s.user_id = core.actor_id()
                                  AND s.quote #>> '{coupon,id}' = coupon.id::text)));
CREATE POLICY web_active ON core.promo_campaign FOR SELECT TO app_web USING (status = 'ACTIVE');

-- ---------------------------------------------------------------- ledger
-- A user's own USER account; MINT and SINK rows (no personal data) are readable.
-- app_web and app_pay read only; accounts are opened by core.provision_account.
CREATE POLICY web_read ON ledger.ledger_account FOR SELECT TO app_web
  USING (user_id = core.actor_id() OR type <> 'USER');
CREATE POLICY pay_read ON ledger.ledger_account FOR SELECT TO app_pay
  USING (user_id = core.actor_id() OR type <> 'USER');

-- Postings: own-account reads only.
CREATE POLICY web_own_read ON ledger.posting FOR SELECT TO app_web
  USING (account_id IN (SELECT a.id FROM ledger.ledger_account a
                         WHERE a.type = 'USER' AND a.user_id = core.actor_id()));
CREATE POLICY pay_own_read ON ledger.posting FOR SELECT TO app_pay
  USING (account_id IN (SELECT a.id FROM ledger.ledger_account a
                         WHERE a.type = 'USER' AND a.user_id = core.actor_id()));

-- Journals: readable when they touch the user's account (posting policy applies inside).
CREATE POLICY web_own_read ON ledger.journal FOR SELECT TO app_web
  USING (EXISTS (SELECT 1 FROM ledger.posting p WHERE p.journal_id = journal.id));
CREATE POLICY pay_own_read ON ledger.journal FOR SELECT TO app_pay
  USING (EXISTS (SELECT 1 FROM ledger.posting p WHERE p.journal_id = journal.id));

-- Wallets: own only, read-only. Other parties' wallets are brought in line inside the command
-- functions through ledger.sync_wallets(), which can only make a wallet equal its postings.
CREATE POLICY web_owner ON ledger.wallet FOR SELECT TO app_web
  USING (account_id IN (SELECT a.id FROM ledger.ledger_account a
                         WHERE a.type = 'USER' AND a.user_id = core.actor_id()));
CREATE POLICY pay_owner ON ledger.wallet FOR SELECT TO app_pay
  USING (account_id IN (SELECT a.id FROM ledger.ledger_account a
                         WHERE a.type = 'USER' AND a.user_id = core.actor_id()));

-- ---------------------------------------------------------------- audit and analytics: append-only for the web
-- (no outbox policy for app_web: outbox events are written only by definer functions, 0011)
CREATE POLICY web_append ON audit.audit_log   FOR INSERT TO app_web WITH CHECK (true);
CREATE POLICY web_append ON analytics.event   FOR INSERT TO app_web WITH CHECK (true);

-- pending admin actions: only the Super Admin, for actions they requested
CREATE POLICY web_super_admin ON audit.pending_action TO app_web
  USING (EXISTS (SELECT 1 FROM core.user_profile p WHERE p.id = core.actor_id() AND p.role = 'SUPER_ADMIN'))
  WITH CHECK (requested_by = core.actor_id()
          AND EXISTS (SELECT 1 FROM core.user_profile p WHERE p.id = core.actor_id() AND p.role = 'SUPER_ADMIN'));

-- experiments: running ones are needed for assignment; exposures are the user's own
CREATE POLICY web_running ON analytics.experiment FOR SELECT TO app_web USING (status = 'RUNNING');
CREATE POLICY web_own ON analytics.experiment_exposure TO app_web
  USING (subject_id = core.actor_id()) WITH CHECK (subject_id = core.actor_id());

-- ---------------------------------------------------------------- sandbox: NPC role only
CREATE POLICY npc_all ON sandbox.npc_actor        TO npc_worker USING (true) WITH CHECK (true);
CREATE POLICY npc_all ON sandbox.simulation_run   TO npc_worker USING (true) WITH CHECK (true);
CREATE POLICY npc_all ON sandbox.simulation_order TO npc_worker USING (true) WITH CHECK (true);
