-- LLD §2: privileges. Runs after every table exists (the LLD lists the grants
-- before the tables, which cannot execute).
--
-- PRIVILEGE SPLIT BY CODE PATH (security review, money path)
--
--  * app_web  - ordinary web requests: reads, plus low-risk writes (profile, own
--               company/product drafts/coupons, addresses, analytics, outbox). It
--               holds NO write privilege on anything that records or moves money,
--               orders, ownership, stock or stock counters, and cannot execute the
--               definer helpers used by pay.
--  * app_pay  - money commands only: provisionAccount, createCheckoutSession,
--               createPaymentAttempt, markAttemptAuthenticated and pay. It is a separate
--               login with its own credential and connection pool; app_web is never a
--               member of it (0001 revokes any such membership, tests assert it). It is
--               still under row-level security with app.user_id set, with a few narrow
--               policies for the other users' rows pay must touch (0012, 0015).
--  * app_jobs - background jobs (admin journals, reconciliation, retention).
--
-- WHAT THIS SPLIT DOES AND DOES NOT PROTECT. The web process holds both credentials
-- (it serves the pay endpoints too). The split therefore stops SQL injection or a
-- query-building bug in an ordinary (app_web) code path from reaching the money
-- tables; it does NOT protect against a full compromise of the web process, which can
-- simply use the app_pay pool. What holds in that case are the structural rules the
-- database enforces for every role, app_pay included (0016): MINT only in grant
-- journals of fixed amounts and in app_jobs-only admin journals; a user journal debits
-- only the acting user's own account; a PURCHASE must be backed, at commit, by a
-- complete and correctly priced order group, payment attempt, session, ownership,
-- inventory issue and coupon redemption; stock and coupon counters must equal the
-- rows they count; attempt and session states only move forward.
--
-- Least privilege, per table and (for INSERT/UPDATE) per column. Row-level security
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
  FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA core, ledger, private, sandbox, analytics, audit, research
  FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA core, ledger, private, sandbox, analytics, audit, research FROM PUBLIC;
REVOKE ALL ON SCHEMA core, ledger, private, sandbox, analytics, audit, research FROM PUBLIC, anon, authenticated;

GRANT USAGE ON SCHEMA core TO app_web, app_pay, app_jobs, npc_worker;
GRANT USAGE ON SCHEMA ledger, analytics, audit TO app_web, app_jobs;
GRANT USAGE ON SCHEMA ledger, audit TO app_pay;
GRANT USAGE ON SCHEMA private TO app_web, app_pay;
GRANT USAGE ON SCHEMA sandbox TO npc_worker;
GRANT USAGE ON SCHEMA research TO research_ro;

-- RLS context helpers, used inside policies.
GRANT EXECUTE ON FUNCTION core.app_user_id(), core.app_company_id() TO app_web, app_pay, app_jobs, npc_worker;

-- ---------------------------------------------------------------- core: reference
GRANT SELECT ON core.config_version, core.system_switch,
                core.fictional_locality, core.fictional_landmark TO app_web, app_pay, app_jobs;

-- ---------------------------------------------------------------- core: identity
GRANT SELECT, INSERT ON core.user_profile TO app_web;
GRANT UPDATE (handle, privacy, research_opt_out, provisioned_at) ON core.user_profile TO app_web;
-- provisioning (app_pay) creates the profile when absent, locks it and stamps provisioned_at
GRANT SELECT ON core.user_profile TO app_pay;
GRANT INSERT (id, email_fingerprint, phone_fingerprint, phone_verified_at) ON core.user_profile TO app_pay;
GRANT UPDATE (provisioned_at) ON core.user_profile TO app_pay;
GRANT SELECT ON core.user_profile TO app_jobs;
GRANT UPDATE (status, provisioned_at) ON core.user_profile TO app_jobs;

GRANT SELECT, INSERT ON core.company TO app_web;
GRANT UPDATE (name) ON core.company TO app_web;
-- app_pay locks selling companies (LLD §4 #4) with SELECT ... FOR UPDATE, which needs
-- an UPDATE privilege; its RLS policy (0012) makes every actual UPDATE fail.
GRANT SELECT ON core.company TO app_pay;
GRANT UPDATE (name) ON core.company TO app_pay;
GRANT SELECT, UPDATE ON core.company TO app_jobs;

-- tombstones: app_web/app_pay ask core.identity_is_tombstoned() (0012) and read nothing;
-- the account-deletion job writes them and the retention job purges expired ones
GRANT SELECT, INSERT, DELETE ON core.identity_tombstone TO app_jobs;

-- ---------------------------------------------------------------- core: bank, cards, payments
-- app_web reads only; every write is a money command (app_pay).
GRANT SELECT ON core.bank_account TO app_web;
GRANT SELECT, INSERT ON core.bank_account TO app_pay;
GRANT SELECT ON core.bank_account TO app_jobs;
GRANT UPDATE (status) ON core.bank_account TO app_jobs;

-- no freeze/unfreeze policy exists for the web role, so it gets no card write at all
GRANT SELECT ON core.virtual_card TO app_web;
GRANT SELECT, INSERT ON core.virtual_card TO app_pay;
GRANT UPDATE (pin_hash, pin_salt, pin_set_at, failed_pin_count, pin_locked_until) ON core.virtual_card TO app_pay;
GRANT SELECT ON core.virtual_card TO app_jobs;
GRANT UPDATE (status, failed_pin_count, pin_locked_until) ON core.virtual_card TO app_jobs;

GRANT SELECT ON core.checkout_session TO app_web;
-- state defaults to OPEN and created_at to now(): neither is caller-supplied
GRANT SELECT, INSERT (id, user_id, type, quote, total_paise, config_version, expires_at) ON core.checkout_session TO app_pay;
GRANT UPDATE (state) ON core.checkout_session TO app_pay, app_jobs;
GRANT SELECT ON core.checkout_session TO app_jobs;

GRANT SELECT ON core.payment_attempt TO app_web;
-- state defaults to PENDING; authenticated_at only for BALANCE (0016)
GRANT SELECT, INSERT (id, session_id, user_id, method, card_id, reference, authenticated_at)
  ON core.payment_attempt TO app_pay;
GRANT UPDATE (state, authenticated_at, failure_code) ON core.payment_attempt TO app_pay;
GRANT SELECT ON core.payment_attempt TO app_jobs;
GRANT UPDATE (state, failure_code) ON core.payment_attempt TO app_jobs;

GRANT SELECT ON core.payment_challenge TO app_web;
GRANT SELECT, INSERT ON core.payment_challenge TO app_pay;
GRANT UPDATE (attempts_used, passed_at) ON core.payment_challenge TO app_pay;
GRANT SELECT ON core.payment_challenge TO app_jobs;

GRANT SELECT ON core.idempotency_record TO app_web;
GRANT SELECT, INSERT ON core.idempotency_record TO app_pay;
GRANT UPDATE (status, response) ON core.idempotency_record TO app_pay;
GRANT SELECT, DELETE ON core.idempotency_record TO app_jobs;   -- retention purge (kept >= 24 h)

-- ---------------------------------------------------------------- core: catalog and inventory
-- A company creates DRAFT products (never with stock or the seed-only zap flag) and
-- moves its own listings' status. Stock counters are written only by app_pay (issue in
-- pay) and app_jobs, and must equal the AVAILABLE units at commit (0016).
GRANT SELECT ON core.product TO app_web;
GRANT INSERT (id, company_id, seller_type, status, current_version_id, category, inventory_mode,
              exclusive_supply, offers_express, free_standard_delivery, published_at) ON core.product TO app_web;
GRANT UPDATE (status) ON core.product TO app_web;
GRANT SELECT ON core.product TO app_pay;
GRANT UPDATE (available_units) ON core.product TO app_pay;              -- stock issue in pay
GRANT SELECT, INSERT, UPDATE ON core.product TO app_jobs;
GRANT SELECT ON core.product_version TO npc_worker, app_pay;
GRANT SELECT, INSERT ON core.product_version TO app_web, app_jobs;   -- immutable: no UPDATE

GRANT SELECT ON core.warehouse TO app_web;
GRANT SELECT ON core.warehouse TO app_pay;
GRANT UPDATE (used) ON core.warehouse TO app_pay;                       -- issue in pay
GRANT SELECT, INSERT, UPDATE ON core.warehouse TO app_jobs;

GRANT SELECT ON core.inventory_unit TO app_web;
GRANT SELECT ON core.inventory_unit TO app_pay;
GRANT UPDATE (state, order_line_id) ON core.inventory_unit TO app_pay;  -- AVAILABLE -> ISSUED only (0012)
GRANT SELECT, INSERT, UPDATE ON core.inventory_unit TO app_jobs;

-- ---------------------------------------------------------------- core: orders (append-only, pay only)
GRANT SELECT ON core.order_group, core.seller_order, core.order_line,
                core.ownership, core.shipment TO app_web;
GRANT SELECT, INSERT ON core.order_group, core.seller_order, core.order_line,
                        core.ownership, core.shipment TO app_pay;
GRANT SELECT ON core.order_group, core.order_line TO app_jobs;
GRANT SELECT ON core.seller_order TO app_jobs;
GRANT UPDATE (status, qualifies_for_progression) ON core.seller_order TO app_jobs;
GRANT SELECT ON core.ownership TO app_jobs;
GRANT UPDATE (state) ON core.ownership TO app_jobs;
GRANT SELECT ON core.shipment TO app_jobs;
GRANT UPDATE (delivered_notified, cancelled_at) ON core.shipment TO app_jobs;

-- ---------------------------------------------------------------- core: promotions and membership
-- Budget and redemption counters are not web-writable. pay does not spend campaign
-- budget yet (no platform coupons), so app_pay gets no UPDATE on promo_campaign either.
GRANT SELECT ON core.promo_campaign TO app_web;
GRANT SELECT, INSERT, UPDATE ON core.promo_campaign TO app_jobs;

GRANT SELECT ON core.coupon TO app_web;
GRANT INSERT (id, scope, company_id, campaign_id, code_normalised, kind, value, min_spend_paise,
              starts_at, ends_at, max_redemptions, is_public, status) ON core.coupon TO app_web;
GRANT SELECT ON core.coupon TO app_pay;
GRANT UPDATE (redeemed) ON core.coupon TO app_pay;                      -- cap, in pay
GRANT SELECT, UPDATE ON core.coupon TO app_jobs;

GRANT SELECT ON core.coupon_redemption, core.membership TO app_web;
GRANT SELECT, INSERT ON core.coupon_redemption TO app_pay;
GRANT SELECT ON core.membership TO app_pay;
GRANT SELECT ON core.coupon_redemption, core.membership TO app_jobs;

-- ---------------------------------------------------------------- ledger: insert-only, money path only
GRANT SELECT ON ledger.journal, ledger.posting, ledger.grant_record, ledger.ledger_account,
                ledger.wallet TO app_web;
GRANT SELECT, INSERT ON ledger.journal, ledger.posting, ledger.grant_record TO app_pay, app_jobs;
-- provisioning creates the user's ledger account (missing from the LLD grant list)
GRANT SELECT, INSERT ON ledger.ledger_account TO app_pay, app_jobs;
GRANT SELECT, INSERT, UPDATE ON ledger.wallet TO app_pay, app_jobs;
GRANT EXECUTE ON FUNCTION ledger.sync_wallets(uuid[]) TO app_pay, app_jobs;
-- no UPDATE/DELETE on journal, posting, grant_record for anyone but the owner

-- ---------------------------------------------------------------- private: web only, owner rows (0012)
GRANT SELECT, INSERT, UPDATE ON private.user_secret TO app_web;
GRANT SELECT, INSERT, UPDATE, DELETE ON private.address TO app_web;   -- a user removes their own address
GRANT SELECT ON private.address TO app_pay;                            -- checkout/pay check the chosen address

-- ---------------------------------------------------------------- sandbox: NPC role only
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA sandbox TO npc_worker;

-- ---------------------------------------------------------------- analytics: web appends; jobs aggregate
GRANT INSERT ON analytics.event TO app_web;
GRANT SELECT ON analytics.experiment TO app_web;
GRANT SELECT, INSERT ON analytics.experiment_exposure TO app_web;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA analytics TO app_jobs;

-- ---------------------------------------------------------------- audit: web appends; jobs relay and read
GRANT INSERT ON audit.outbox, audit.audit_log TO app_web;
GRANT INSERT ON audit.outbox TO app_pay;                                -- purchase_completed
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
