-- LLD §2: privileges. Runs after every table exists (the LLD lists the grants
-- before the tables, which cannot execute).
--
-- Least privilege, per table and (for UPDATE) per column. Row-level security
-- (0012) further limits which rows each grant reaches. Rules:
--  * configuration (config_version, system_switch) is read-only for application
--    roles; it is written only by the owner through a controlled path;
--  * nothing an application role can delete is a record of money, ownership,
--    an order, a payment or an identity tombstone; app_web deletes only data a
--    user removes themselves (addresses);
--  * app_web cannot change a profile's role, test flag, status, adulthood or
--    fingerprints.

-- Start from nothing: no table, sequence or function privilege by default.
REVOKE ALL ON ALL TABLES IN SCHEMA core, ledger, private, sandbox, analytics, audit, research
  FROM PUBLIC, anon, authenticated, app_web, app_jobs, npc_worker, research_ro;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA core, ledger, private, sandbox, analytics, audit, research
  FROM PUBLIC, anon, authenticated, app_web, app_jobs, npc_worker, research_ro;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA core, ledger, private, sandbox, analytics, audit, research FROM PUBLIC;
REVOKE ALL ON SCHEMA core, ledger, private, sandbox, analytics, audit, research FROM PUBLIC, anon, authenticated;

GRANT USAGE ON SCHEMA core TO app_web, app_jobs, npc_worker;
GRANT USAGE ON SCHEMA ledger, analytics, audit TO app_web, app_jobs;
GRANT USAGE ON SCHEMA private TO app_web;
GRANT USAGE ON SCHEMA sandbox TO npc_worker;
GRANT USAGE ON SCHEMA research TO research_ro;

-- RLS context helpers, used inside policies.
GRANT EXECUTE ON FUNCTION core.app_user_id(), core.app_company_id() TO app_web, app_jobs, npc_worker;

-- ---------------------------------------------------------------- core: reference
GRANT SELECT ON core.config_version, core.system_switch,
                core.fictional_locality, core.fictional_landmark TO app_web, app_jobs;

-- ---------------------------------------------------------------- core: identity
GRANT SELECT, INSERT ON core.user_profile TO app_web;
GRANT UPDATE (handle, privacy, research_opt_out, provisioned_at) ON core.user_profile TO app_web;
GRANT SELECT ON core.user_profile TO app_jobs;
GRANT UPDATE (status, provisioned_at) ON core.user_profile TO app_jobs;

GRANT SELECT, INSERT ON core.company TO app_web;
GRANT UPDATE (name) ON core.company TO app_web;
GRANT SELECT, UPDATE ON core.company TO app_jobs;

-- tombstones: app_web asks core.identity_is_tombstoned() (0012) and reads nothing;
-- the account-deletion job writes them and the retention job purges expired ones
GRANT SELECT, INSERT, DELETE ON core.identity_tombstone TO app_jobs;

-- ---------------------------------------------------------------- core: bank, cards, payments
GRANT SELECT, INSERT ON core.bank_account TO app_web;
GRANT SELECT ON core.bank_account TO app_jobs;
GRANT UPDATE (status) ON core.bank_account TO app_jobs;

GRANT SELECT, INSERT ON core.virtual_card TO app_web;
GRANT UPDATE (status, pin_hash, pin_salt, pin_set_at, failed_pin_count, pin_locked_until)
  ON core.virtual_card TO app_web;
GRANT SELECT ON core.virtual_card TO app_jobs;
GRANT UPDATE (status, failed_pin_count, pin_locked_until) ON core.virtual_card TO app_jobs;

GRANT SELECT, INSERT ON core.checkout_session TO app_web;
GRANT UPDATE (state) ON core.checkout_session TO app_web, app_jobs;
GRANT SELECT ON core.checkout_session TO app_jobs;

GRANT SELECT, INSERT ON core.payment_attempt TO app_web;
GRANT UPDATE (state, authenticated_at, failure_code) ON core.payment_attempt TO app_web;
GRANT SELECT ON core.payment_attempt TO app_jobs;
GRANT UPDATE (state, failure_code) ON core.payment_attempt TO app_jobs;

GRANT SELECT, INSERT ON core.payment_challenge TO app_web;
GRANT UPDATE (attempts_used, passed_at) ON core.payment_challenge TO app_web;
GRANT SELECT ON core.payment_challenge TO app_jobs;

GRANT SELECT, INSERT ON core.idempotency_record TO app_web;
GRANT UPDATE (status, response) ON core.idempotency_record TO app_web;
GRANT SELECT, DELETE ON core.idempotency_record TO app_jobs;   -- retention purge (kept >= 24 h)

-- ---------------------------------------------------------------- core: catalog and inventory
GRANT SELECT, INSERT ON core.product TO app_web;
GRANT UPDATE (status, available_units) ON core.product TO app_web;    -- submit; stock issue in pay
GRANT SELECT, INSERT, UPDATE ON core.product TO app_jobs;
GRANT SELECT ON core.product_version TO npc_worker;
GRANT SELECT, INSERT ON core.product_version TO app_web, app_jobs;   -- immutable: no UPDATE

GRANT SELECT ON core.warehouse TO app_web;
GRANT UPDATE (used) ON core.warehouse TO app_web;
GRANT SELECT, INSERT, UPDATE ON core.warehouse TO app_jobs;

GRANT SELECT ON core.inventory_unit TO app_web;
GRANT UPDATE (state, order_line_id) ON core.inventory_unit TO app_web;
GRANT SELECT, INSERT, UPDATE ON core.inventory_unit TO app_jobs;

-- ---------------------------------------------------------------- core: orders (append-only for the app)
GRANT SELECT, INSERT ON core.order_group, core.seller_order, core.order_line,
                        core.ownership, core.shipment TO app_web;
GRANT SELECT ON core.order_group, core.order_line TO app_jobs;
GRANT SELECT ON core.seller_order TO app_jobs;
GRANT UPDATE (status, qualifies_for_progression) ON core.seller_order TO app_jobs;
GRANT SELECT ON core.ownership TO app_jobs;
GRANT UPDATE (state) ON core.ownership TO app_jobs;
GRANT SELECT ON core.shipment TO app_jobs;
GRANT UPDATE (delivered_notified, cancelled_at) ON core.shipment TO app_jobs;

-- ---------------------------------------------------------------- core: promotions and membership
GRANT SELECT ON core.promo_campaign TO app_web;
GRANT UPDATE (spent_paise) ON core.promo_campaign TO app_web;          -- budget, in pay
GRANT SELECT, INSERT, UPDATE ON core.promo_campaign TO app_jobs;

GRANT SELECT, INSERT ON core.coupon TO app_web;
GRANT UPDATE (redeemed) ON core.coupon TO app_web;                      -- cap, in pay
GRANT SELECT, UPDATE ON core.coupon TO app_jobs;

GRANT SELECT, INSERT ON core.coupon_redemption, core.membership TO app_web;
GRANT SELECT ON core.coupon_redemption, core.membership TO app_jobs;

-- ---------------------------------------------------------------- ledger: insert-only for the application
GRANT SELECT, INSERT ON ledger.journal, ledger.posting, ledger.grant_record TO app_web, app_jobs;
-- provisioning creates the user's ledger account (missing from the LLD grant list)
GRANT SELECT, INSERT ON ledger.ledger_account TO app_web, app_jobs;
GRANT SELECT, INSERT, UPDATE ON ledger.wallet TO app_web, app_jobs;
GRANT EXECUTE ON FUNCTION ledger.sync_wallets(uuid[]) TO app_web, app_jobs;
-- no UPDATE/DELETE on journal, posting, grant_record for anyone but the owner

-- ---------------------------------------------------------------- private: web only, owner rows (0012)
GRANT SELECT, INSERT, UPDATE ON private.user_secret TO app_web;
GRANT SELECT, INSERT, UPDATE, DELETE ON private.address TO app_web;   -- a user removes their own address

-- ---------------------------------------------------------------- sandbox: NPC role only
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA sandbox TO npc_worker;

-- ---------------------------------------------------------------- analytics: web appends; jobs aggregate
GRANT INSERT ON analytics.event TO app_web;
GRANT SELECT ON analytics.experiment TO app_web;
GRANT SELECT, INSERT ON analytics.experiment_exposure TO app_web;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA analytics TO app_jobs;

-- ---------------------------------------------------------------- audit: web appends; jobs relay and read
GRANT INSERT ON audit.outbox, audit.audit_log TO app_web;
GRANT SELECT, INSERT ON audit.outbox, audit.audit_log TO app_jobs;
GRANT UPDATE (relayed_at) ON audit.outbox TO app_jobs;
GRANT SELECT, INSERT ON audit.consumer_receipt TO app_jobs;
-- Super Admin queues delayed actions from the web console (rows limited to the admin by RLS)
GRANT SELECT, INSERT ON audit.pending_action TO app_web;
GRANT UPDATE (state) ON audit.pending_action TO app_web;
GRANT SELECT ON audit.pending_action TO app_jobs;
GRANT UPDATE (state, executed_at) ON audit.pending_action TO app_jobs;

-- ---------------------------------------------------------------- research: read-only, including later tables
GRANT SELECT ON ALL TABLES IN SCHEMA research TO research_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA research GRANT SELECT ON TABLES TO research_ro;
