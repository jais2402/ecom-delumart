-- LLD §2: privileges. Runs after every table exists (the LLD lists the grants
-- before the tables, which cannot execute).
--
-- WHO THE ACTOR IS. Every owner-scoped policy, structural check and command function derives
-- the acting user from the sign-in session (core.actor_id(), 0001): the connection supplies
-- only the session id (app.session_id), a bearer secret, never a user id. A holder of an
-- application credential without a victim's session id therefore cannot act as the victim.
--
-- NO RAW MONEY WRITES. No application role (app_web, app_pay) holds INSERT, UPDATE or DELETE
-- on anything that records or moves money, identity, orders, ownership, payments, stock or
-- stock counters. Every such write goes through an owner-run SECURITY DEFINER command function
-- (0018) that derives the actor itself, locks in the canonical order (LLD §4) with its own
-- lock_timeout, writes, and runs the full structural validation (0016) synchronously before
-- returning. Because SELECT ... FOR UPDATE / FOR NO KEY UPDATE / FOR SHARE / FOR KEY SHARE
-- need UPDATE (or DELETE) privilege, the application roles also cannot hold row locks on
-- these tables, so they cannot keep another buyer's pay() waiting.
--
--  * app_web  - ordinary web requests: reads, plus low-risk writes (own company/product
--               drafts/coupons, addresses, secrets, analytics, outbox). No money command.
--  * app_pay  - money commands only, through the functions of 0018 (EXECUTE only to it):
--               provisioning, checkout, payment attempts, attempt authentication, pay. A
--               separate login with its own credential and pool; app_web is never a member
--               of it (0001). It reads (own rows under RLS) what the pricing function needs.
--  * app_jobs - background jobs (admin journals, reconciliation, retention). Acts as no user:
--               core.actor_id() is NULL for it whatever session id it sets, and it cannot
--               execute the user-scoped command functions.
--
-- Least privilege, per table and (for INSERT/UPDATE) per column. Row-level security
-- (0012) further limits which rows each grant reaches. Configuration (config_version,
-- system_switch) is read-only for application roles. Nothing an application role can
-- delete is a record of money, ownership, an order, a payment or an identity tombstone;
-- app_web deletes only data a user removes themselves (addresses).

-- Start from nothing: no table, sequence or function privilege by default.
REVOKE ALL ON ALL TABLES IN SCHEMA core, ledger, private, sandbox, analytics, audit, research
  FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA core, ledger, private, sandbox, analytics, audit, research
  FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA core, ledger, private, sandbox, analytics, audit, research FROM PUBLIC;
REVOKE ALL ON SCHEMA core, ledger, private, sandbox, analytics, audit, research FROM PUBLIC, anon, authenticated;

GRANT USAGE ON SCHEMA core TO app_web, app_pay, app_jobs, npc_worker;
GRANT USAGE ON SCHEMA ledger, analytics, audit TO app_web, app_jobs;
GRANT USAGE ON SCHEMA ledger TO app_pay;
GRANT USAGE ON SCHEMA private TO app_web, app_pay;
GRANT USAGE ON SCHEMA sandbox TO npc_worker;
GRANT USAGE ON SCHEMA research TO research_ro;

-- The acting user, used inside policies (company scope is core.actor_company_ids(), 0012).
GRANT EXECUTE ON FUNCTION core.actor_id() TO app_web, app_pay;

-- ---------------------------------------------------------------- core: reference
GRANT SELECT ON core.config_version, core.system_switch,
                core.fictional_locality, core.fictional_landmark TO app_web, app_pay, app_jobs;

-- ---------------------------------------------------------------- core: identity
-- A profile is created only by core.provision_account (0018), for the signed-in actor.
GRANT SELECT ON core.user_profile TO app_web, app_pay;
GRANT SELECT ON core.user_profile TO app_jobs;
GRANT UPDATE (status, provisioned_at) ON core.user_profile TO app_jobs;

GRANT SELECT, INSERT ON core.company TO app_web;
GRANT UPDATE (name) ON core.company TO app_web;          -- own company only (RLS)
GRANT SELECT ON core.company TO app_pay;                  -- read only: no lock on any company
GRANT SELECT, UPDATE ON core.company TO app_jobs;

-- tombstones: checked inside core.provision_account; the account-deletion job writes them
-- and the retention job purges expired ones
GRANT SELECT, INSERT, DELETE ON core.identity_tombstone TO app_jobs;

-- ---------------------------------------------------------------- core: bank, cards, payments
-- Read-only for app_web and app_pay: every write is a command function.
GRANT SELECT ON core.bank_account, core.virtual_card, core.checkout_session, core.payment_attempt,
                core.payment_challenge, core.idempotency_record TO app_web, app_pay;
GRANT SELECT ON core.bank_account TO app_jobs;
GRANT UPDATE (status) ON core.bank_account TO app_jobs;
GRANT SELECT ON core.virtual_card TO app_jobs;
GRANT UPDATE (status, failed_pin_count, pin_locked_until) ON core.virtual_card TO app_jobs;
GRANT SELECT ON core.checkout_session TO app_jobs;
GRANT UPDATE (state) ON core.checkout_session TO app_jobs;      -- expiry
GRANT SELECT ON core.payment_attempt TO app_jobs;
GRANT UPDATE (state, failure_code) ON core.payment_attempt TO app_jobs;
GRANT SELECT ON core.payment_challenge TO app_jobs;
GRANT SELECT ON core.idempotency_record TO app_jobs;            -- purge: core.purge_idempotency_records()

-- ---------------------------------------------------------------- core: catalog and inventory
-- A company owner creates DRAFT products (never with stock, unlimited stock or the
-- seed-only zap flag), submits them for screening with a version, and archives its own
-- listings; which status moves each role may make is enforced by a trigger (0017). Stock
-- counters are written only by core.commit_purchase (issue) and app_jobs, and must equal the
-- AVAILABLE units at commit (0016).
GRANT SELECT ON core.product TO app_web, app_pay;
GRANT INSERT (id, company_id, seller_type, status, current_version_id, category, inventory_mode,
              exclusive_supply, offers_express, free_standard_delivery, published_at) ON core.product TO app_web;
GRANT UPDATE (status, current_version_id) ON core.product TO app_web;   -- own company only (RLS)
GRANT SELECT, INSERT, UPDATE ON core.product TO app_jobs;
GRANT SELECT ON core.product_version TO npc_worker, app_pay;
GRANT SELECT, INSERT ON core.product_version TO app_web, app_jobs;   -- immutable: no UPDATE

GRANT SELECT ON core.warehouse, core.inventory_unit TO app_web, app_pay;
GRANT SELECT, INSERT, UPDATE ON core.warehouse, core.inventory_unit TO app_jobs;

-- ---------------------------------------------------------------- core: orders (written only by commit_purchase)
-- Purchases are anonymous to sellers (PRD): app_web, through which a company owner reads its
-- seller orders, gets every seller_order column except buyer_user_id.
GRANT SELECT ON core.order_group, core.order_line, core.ownership, core.shipment TO app_web;
GRANT SELECT (id, order_group_id, company_id, seller_type, list_paise, seller_discount_paise,
              platform_discount_paise, fee_paise, delivery_fee_buyer_paise, delivery_fee_seller_paise,
              net_paise, status, qualifies_for_progression) ON core.seller_order TO app_web;
GRANT SELECT ON core.order_group, core.seller_order, core.order_line, core.ownership, core.shipment TO app_pay;
GRANT SELECT ON core.order_group, core.order_line TO app_jobs;
GRANT SELECT ON core.seller_order TO app_jobs;
GRANT UPDATE (status, qualifies_for_progression) ON core.seller_order TO app_jobs;
GRANT SELECT ON core.ownership TO app_jobs;
GRANT UPDATE (state) ON core.ownership TO app_jobs;
GRANT SELECT ON core.shipment TO app_jobs;
GRANT UPDATE (delivered_notified, cancelled_at) ON core.shipment TO app_jobs;

-- ---------------------------------------------------------------- core: promotions and membership
-- Budget and redemption counters are written only by commit_purchase and app_jobs.
GRANT SELECT ON core.promo_campaign TO app_web;
GRANT SELECT, INSERT, UPDATE ON core.promo_campaign TO app_jobs;

GRANT SELECT ON core.coupon TO app_web;
GRANT INSERT (id, scope, company_id, campaign_id, code_normalised, kind, value, min_spend_paise,
              starts_at, ends_at, max_redemptions, is_public, status) ON core.coupon TO app_web;
GRANT SELECT ON core.coupon TO app_pay;
GRANT SELECT, UPDATE ON core.coupon TO app_jobs;

GRANT SELECT ON core.coupon_redemption, core.membership TO app_web, app_pay, app_jobs;

-- ---------------------------------------------------------------- ledger: read-only for the application
GRANT SELECT ON ledger.journal, ledger.posting, ledger.grant_record, ledger.ledger_account,
                ledger.wallet TO app_web, app_pay;
GRANT SELECT, INSERT ON ledger.journal, ledger.posting, ledger.grant_record, ledger.ledger_account TO app_jobs;
GRANT SELECT, INSERT, UPDATE ON ledger.wallet TO app_jobs;
GRANT EXECUTE ON FUNCTION ledger.sync_wallets(uuid[]) TO app_jobs;
-- no UPDATE/DELETE on journal, posting, grant_record for anyone but the owner

-- ---------------------------------------------------------------- private: web only, owner rows (0012)
GRANT SELECT, INSERT, UPDATE ON private.user_secret TO app_web;
GRANT SELECT, INSERT, UPDATE, DELETE ON private.address TO app_web;   -- a user removes their own address
GRANT SELECT ON private.address TO app_pay;                            -- checkout checks the chosen address

-- ---------------------------------------------------------------- sandbox: NPC role only
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA sandbox TO npc_worker;

-- ---------------------------------------------------------------- analytics: web appends; jobs aggregate
GRANT INSERT ON analytics.event TO app_web;
GRANT SELECT ON analytics.experiment TO app_web;
GRANT SELECT, INSERT ON analytics.experiment_exposure TO app_web;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA analytics TO app_jobs;

-- ---------------------------------------------------------------- audit: web appends; jobs relay and read
-- purchase_completed is written by core.commit_purchase, not by an application role
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
