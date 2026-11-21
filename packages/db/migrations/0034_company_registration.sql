-- Company registration (E, US-18, US-19): the first company of a person with creator access, paid
-- once through the checkout mechanism with checkout type COMPANY_REGISTRATION.
--
--  * core.company_quote(handle, display_name, description) creates the COMPANY_REGISTRATION
--    checkout session (fee from configuration, `company_registration_fee_paise`, ₹5 lakh) and a
--    private reservation of the handle for `company_quote_ttl_seconds` (300): nobody else can
--    reserve or register the handle meanwhile; an expired quote takes no money and frees it.
--  * The payment attempt and the card PIN step are the purchase ones (core.create_payment_attempt,
--    core.verify_card_pin), which accept any checkout session of the actor.
--  * core.commit_company_registration(session, attempt, key, hash) is the pay transaction: under
--    the actor's progression lock, the session (LLD §4 #1), the handle's reservation lock, the card
--    (#8) and the wallet (#9), it validates the entitlement, the quote, the name, the card and the
--    balance, then posts ONE COMPANY_REGISTRATION journal (owner -paid, MINT -sponsorship, SINK
--    +fee), creates the company (tier SOLO), its registration record and exactly one STARTER
--    warehouse (`starter_warehouse_capacity`, 100), marks the attempt and session SUCCEEDED and
--    writes an outbox row (ids and amounts only). Idempotent per key; at most one company and one
--    charge per person whatever the keys, attempts or concurrency.
--  * It is not a product order: no order group, seller order or ownership, no GMV, and it never
--    records the spending route of creator access.
--  * Formation sponsorship (US-19): when the balance is below the fee and the person has passed
--    the passport quiz, a once-per-lifetime sponsorship covers exactly the shortfall inside the
--    same journal (MINT debited), recorded in core.formation_sponsorship. It is never credited to
--    the wallet and exists only with a successful registration.
--
-- The database verifies the handle's format (3-24 of a-z, 0-9, single inner hyphens), the
-- reserved list, uniqueness ignoring case, the name (3-40 characters after trimming, no control
-- characters) and the description (at most 280 characters). It TAKES ON THE WEB SERVER'S WORD that
-- the three passed text screening (packages/core/src/screening): the web layer refuses anything
-- whose verdict is not OK before calling.
--
-- Structural rules (second line, every writer): a COMPANY_REGISTRATION journal is created only by
-- the owner (the definer functions; refused for every other role), debits at most one USER
-- account, the actor's, by at most the fee, debits MINT only by the exact shortfall with a
-- formation_sponsorship row of the actor in the same transaction (passport quiz passed, the
-- balance emptied), credits SINK exactly the configured fee, and is referenced by exactly one
-- registration record, whose session, attempt, company and starter warehouse are checked too.

-- ---------------------------------------------------------------- the company
CREATE FUNCTION core.reserved_store_handles() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['admin', 'support', 'delulumart', 'delulu', 'staff', 'official', 'help', 'system', 'root',
               'moderator', 'bank', 'pay', 'originals', 'store', 'shop', 'www', 'api', 'account', 'cart',
               'checkout', 'orders', 'console', 'partner']
$$;

CREATE FUNCTION core.store_handle_valid(h text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT h ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(h) BETWEEN 3 AND 24
$$;

ALTER TABLE core.company
  ADD COLUMN handle       text,
  ADD COLUMN description  text NOT NULL DEFAULT '',
  ADD COLUMN tier         text NOT NULL DEFAULT 'SOLO' CHECK (tier IN ('SOLO', 'BRAND')),
  ADD COLUMN updated_at   timestamptz,
  ADD COLUMN created_txid bigint NOT NULL DEFAULT txid_current(),
  ADD CONSTRAINT company_handle_rules CHECK (
    handle IS NULL OR (core.store_handle_valid(handle) AND handle <> ALL (core.reserved_store_handles()))),
  ADD CONSTRAINT company_name_rules CHECK (
    name = btrim(name) AND char_length(name) BETWEEN 3 AND 40 AND name !~ '[[:cntrl:]]'),
  ADD CONSTRAINT company_description_rules CHECK (
    description = btrim(description) AND char_length(description) <= 280
    AND description !~ '[\x01-\x09\x0b-\x1f\x7f]');
CREATE UNIQUE INDEX company_handle_ci ON core.company (lower(handle)) WHERE handle IS NOT NULL;
-- one company per person (in this release, forever)
CREATE UNIQUE INDEX one_company_per_owner ON core.company (owner_user_id);
CREATE TRIGGER stamp_txid BEFORE INSERT ON core.company
  FOR EACH ROW EXECUTE FUNCTION ledger.stamp_journal_txid();

-- The handle, owner and identity of a company never change (its name and description may).
CREATE FUNCTION core.guard_company() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW.id, NEW.owner_user_id, NEW.handle, NEW.created_at, NEW.created_txid)
     IS DISTINCT FROM (OLD.id, OLD.owner_user_id, OLD.handle, OLD.created_at, OLD.created_txid) THEN
    RAISE EXCEPTION 'company %: its owner and handle never change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard BEFORE UPDATE ON core.company
  FOR EACH ROW EXECUTE FUNCTION core.guard_company();

-- Companies are created and renamed only through the definer functions below.
DROP POLICY web_owner_insert ON core.company;
DROP POLICY web_owner_update ON core.company;
REVOKE INSERT, UPDATE ON core.company FROM app_web;

-- ---------------------------------------------------------------- reservations, sponsorship, registration
-- A handle held by a COMPANY_REGISTRATION quote: live while its session is OPEN and unexpired.
CREATE TABLE core.handle_reservation (
  session_id uuid PRIMARY KEY REFERENCES core.checkout_session (id),
  user_id    uuid NOT NULL REFERENCES core.user_profile (id),
  handle     text NOT NULL CHECK (core.store_handle_valid(handle)),
  expires_at timestamptz NOT NULL
);
CREATE INDEX handle_reservation_handle ON core.handle_reservation (handle, expires_at);

CREATE TABLE core.formation_sponsorship (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL UNIQUE REFERENCES core.user_profile (id),   -- once per lifetime
  journal_id   uuid NOT NULL UNIQUE REFERENCES ledger.journal (id),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_txid bigint NOT NULL DEFAULT txid_current()
);
CREATE TRIGGER stamp_txid BEFORE INSERT ON core.formation_sponsorship
  FOR EACH ROW EXECUTE FUNCTION ledger.stamp_journal_txid();

CREATE TABLE core.company_registration (
  id                 uuid PRIMARY KEY,
  company_id         uuid NOT NULL UNIQUE REFERENCES core.company (id),
  user_id            uuid NOT NULL UNIQUE REFERENCES core.user_profile (id),
  session_id         uuid NOT NULL UNIQUE REFERENCES core.checkout_session (id),
  payment_attempt_id uuid NOT NULL UNIQUE REFERENCES core.payment_attempt (id),
  journal_id         uuid NOT NULL UNIQUE REFERENCES ledger.journal (id),
  fee_paise          bigint NOT NULL CHECK (fee_paise > 0),
  paid_paise         bigint NOT NULL CHECK (paid_paise >= 0),
  sponsorship_paise  bigint NOT NULL CHECK (sponsorship_paise >= 0),
  config_version     int NOT NULL REFERENCES core.config_version (id),
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_txid       bigint NOT NULL DEFAULT txid_current(),
  CHECK (paid_paise + sponsorship_paise = fee_paise)
);
CREATE TRIGGER stamp_txid BEFORE INSERT ON core.company_registration
  FOR EACH ROW EXECUTE FUNCTION ledger.stamp_journal_txid();

ALTER TABLE core.handle_reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.formation_sponsorship ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.company_registration ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.handle_reservation, core.formation_sponsorship, core.company_registration
  FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;
-- No application role reads reservations; this policy only says what a grant would have to respect.
CREATE POLICY own_rows ON core.handle_reservation FOR SELECT TO app_web, app_pay USING (user_id = core.actor_id());
GRANT SELECT ON core.formation_sponsorship, core.company_registration TO app_jobs;   -- reconciliation
CREATE POLICY jobs_read ON core.formation_sponsorship FOR SELECT TO app_jobs USING (true);
CREATE POLICY jobs_read ON core.company_registration FOR SELECT TO app_jobs USING (true);

-- Records of money: never changed, never deleted, nothing added once their journal is sealed.
CREATE FUNCTION core.guard_registration_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '% % never changes', TG_TABLE_NAME, OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF ledger.journal_is_sealed(NEW.journal_id) THEN
    RAISE EXCEPTION '% row refused: its journal has already been checked and sealed', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard BEFORE INSERT OR UPDATE ON core.formation_sponsorship
  FOR EACH ROW EXECUTE FUNCTION core.guard_registration_record();
CREATE TRIGGER guard BEFORE INSERT OR UPDATE ON core.company_registration
  FOR EACH ROW EXECUTE FUNCTION core.guard_registration_record();
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['core.formation_sponsorship', 'core.company_registration'] LOOP
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION core.refuse_delete()', t);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION core.refuse_delete()', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- R8 revisited: who creates the journal
-- COMPANY_REGISTRATION is now backed (records and checks below) but is still created only by the
-- owner: the definer functions of this migration. Any other role, however privileged, is refused.
-- WAREHOUSE_PURCHASE and MEMBERSHIP stay unavailable to the application roles.
CREATE OR REPLACE FUNCTION ledger.assert_admin_journal_role() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  is_owner boolean := COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false)
                      OR pg_has_role(current_user, 'migrator', 'MEMBER');
BEGIN
  IF NEW.event_type IN ('COMPENSATION', 'REVERSAL', 'ACCOUNT_RETIREMENT') AND NOT is_owner THEN
    RAISE EXCEPTION '% journals are created only by the database owner, not %', NEW.event_type, current_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.event_type = 'COMPANY_REGISTRATION' AND NOT is_owner THEN
    RAISE EXCEPTION 'COMPANY_REGISTRATION journals are created only by core.commit_company_registration, not %',
      current_user USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.event_type IN ('WAREHOUSE_PURCHASE', 'MEMBERSHIP') AND current_user IN ('app_pay', 'app_web') THEN
    RAISE EXCEPTION '% journals are not available until their backing records and checks exist', NEW.event_type
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- the COMPANY_REGISTRATION journal
CREATE FUNCTION ledger.assert_company_registration_journal(j_id uuid, actor uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cfg        int;
  fee        bigint;
  actor_acct uuid;
  user_dr    int;
  user_cr    int;
  mint_cr    int;
  sink_dr    int;
  debited    uuid;
  paid       bigint;
  minted     bigint;
  sunk       bigint;
  prior      bigint;
  sp         core.formation_sponsorship;
  sps        int;
  reg        core.company_registration;
  regs       int;
BEGIN
  SELECT j.config_version INTO cfg FROM ledger.journal j WHERE j.id = j_id;
  fee := core.config_paise(cfg, ARRAY['company_registration_fee_paise'], 50000000);
  SELECT la.id INTO actor_acct FROM ledger.ledger_account la WHERE la.user_id = actor AND la.type = 'USER';
  SELECT count(DISTINCT p.account_id) FILTER (WHERE a.type = 'USER' AND p.amount < 0),
         count(*) FILTER (WHERE a.type = 'USER' AND p.amount > 0),
         count(*) FILTER (WHERE a.type = 'MINT' AND p.amount > 0),
         count(*) FILTER (WHERE a.type = 'SINK' AND p.amount < 0),
         COALESCE(-SUM(p.amount) FILTER (WHERE a.type = 'USER' AND p.amount < 0), 0),
         COALESCE(-SUM(p.amount) FILTER (WHERE a.type = 'MINT'), 0),
         COALESCE(SUM(p.amount) FILTER (WHERE a.type = 'SINK'), 0)
    INTO user_dr, user_cr, mint_cr, sink_dr, paid, minted, sunk
    FROM ledger.posting p JOIN ledger.ledger_account a ON a.id = p.account_id
   WHERE p.journal_id = j_id;

  IF mint_cr > 0 OR sink_dr > 0 THEN
    RAISE EXCEPTION 'COMPANY_REGISTRATION journal % may only debit MINT and only credit SINK', j_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF user_dr > 1 THEN
    RAISE EXCEPTION 'COMPANY_REGISTRATION journal % must debit at most one USER account, not %', j_id, user_dr
      USING ERRCODE = 'check_violation';
  END IF;
  IF user_dr = 1 THEN
    SELECT DISTINCT p.account_id INTO debited
      FROM ledger.posting p JOIN ledger.ledger_account a ON a.id = p.account_id
     WHERE p.journal_id = j_id AND a.type = 'USER' AND p.amount < 0;
    IF actor_acct IS NULL OR debited IS DISTINCT FROM actor_acct THEN
      RAISE EXCEPTION 'COMPANY_REGISTRATION journal % may debit only the acting user''s own account (the signed-in session)', j_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- formation sponsorship: MINT only for the exact shortfall, once per lifetime, after the quiz
  SELECT count(*) INTO sps FROM core.formation_sponsorship s WHERE s.journal_id = j_id;
  SELECT * INTO sp FROM core.formation_sponsorship s WHERE s.journal_id = j_id;
  IF minted > 0 THEN
    IF sps <> 1 OR sp.user_id IS DISTINCT FROM actor OR sp.amount_paise IS DISTINCT FROM minted
       OR sp.created_txid IS DISTINCT FROM txid_current() THEN
      RAISE EXCEPTION 'COMPANY_REGISTRATION journal % may not post to MINT except for a formation sponsorship of the owner, of exactly that amount, in this transaction', j_id
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT COALESCE(SUM(p.amount), 0) INTO prior FROM ledger.posting p
     WHERE p.account_id = actor_acct AND p.journal_id <> j_id;
    IF prior IS DISTINCT FROM paid THEN
      RAISE EXCEPTION 'COMPANY_REGISTRATION journal %: a sponsorship covers exactly the shortfall (the owner pays all of their % paise)', j_id, prior
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM core.passport_progress pp WHERE pp.user_id = actor AND pp.quiz_passed_at IS NOT NULL) THEN
      RAISE EXCEPTION 'COMPANY_REGISTRATION journal %: a formation sponsorship needs the passport quiz passed', j_id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF sps > 0 THEN
    RAISE EXCEPTION 'COMPANY_REGISTRATION journal %: a sponsorship row without a MINT debit', j_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF user_cr > 0 THEN
    RAISE EXCEPTION 'COMPANY_REGISTRATION journal % pays the platform: it may credit SINK only', j_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF sunk <> fee THEN
    RAISE EXCEPTION 'COMPANY_REGISTRATION journal %: SINK must be credited exactly the configured fee % (not %)', j_id, fee, sunk
      USING ERRCODE = 'check_violation';
  END IF;
  IF paid > fee THEN
    RAISE EXCEPTION 'COMPANY_REGISTRATION journal %: the owner pays at most the fee', j_id USING ERRCODE = 'check_violation';
  END IF;

  -- exactly one registration record, of the actor, for these amounts
  SELECT count(*) INTO regs FROM core.company_registration r WHERE r.journal_id = j_id;
  SELECT * INTO reg FROM core.company_registration r WHERE r.journal_id = j_id;
  IF regs <> 1 OR reg.user_id IS DISTINCT FROM actor OR reg.fee_paise IS DISTINCT FROM fee
     OR reg.paid_paise IS DISTINCT FROM paid OR reg.sponsorship_paise IS DISTINCT FROM minted
     OR reg.config_version IS DISTINCT FROM cfg THEN
    RAISE EXCEPTION 'COMPANY_REGISTRATION journal % must be referenced by exactly one registration record of the owner for its amounts', j_id
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- 0016's journal rules, unchanged except for the COMPANY_REGISTRATION branch (which until now fell
-- under the purchase rules and was refused for every application role by R8).
CREATE OR REPLACE FUNCTION ledger.assert_journal_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ev        text;
  j_created timestamptz;
  j_group   uuid;
  n         int;
  mint_n    int;
  mint_dr   int;
  mint_cr   int;
  sink_cr   int;
  sink_dr   int;
  user_cr   int;
  user_dr   int;
  user_net  bigint;
  actor     uuid := core.actor_id();
  actor_acct uuid;
  debited   uuid;
  grants    int;
  gr        record;
  credited  record;
  prior     bigint;
  reliefs   int;
  grp       record;
  groups    int;
  buyer_debit bigint;
  sink_sum  bigint;
  sink_due  bigint;
BEGIN
  PERFORM ledger.require_read_committed();
  -- R9: what is judged here is final; postings or grant records added later are refused
  INSERT INTO ledger.journal_seal (journal_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  SELECT event_type, created_at, order_group_id INTO ev, j_created, j_group FROM ledger.journal WHERE id = NEW.id;
  SELECT count(*),
         count(*) FILTER (WHERE a.type = 'MINT'),
         count(*) FILTER (WHERE a.type = 'MINT' AND p.amount < 0),
         count(*) FILTER (WHERE a.type = 'MINT' AND p.amount > 0),
         count(*) FILTER (WHERE a.type = 'SINK' AND p.amount > 0),
         count(*) FILTER (WHERE a.type = 'SINK' AND p.amount < 0),
         count(DISTINCT p.account_id) FILTER (WHERE a.type = 'USER' AND p.amount > 0),
         count(DISTINCT p.account_id) FILTER (WHERE a.type = 'USER' AND p.amount < 0),
         COALESCE(SUM(p.amount) FILTER (WHERE a.type = 'USER'), 0)
    INTO n, mint_n, mint_dr, mint_cr, sink_cr, sink_dr, user_cr, user_dr, user_net
    FROM ledger.posting p JOIN ledger.ledger_account a ON a.id = p.account_id
   WHERE p.journal_id = NEW.id;

  IF n < 2 THEN
    RAISE EXCEPTION 'journal % (%) has % posting(s); a journal needs at least two postings', NEW.id, ev, n
      USING ERRCODE = 'check_violation';
  END IF;

  -- ------------------------------------------------ grants and admin types
  IF ev IN ('STARTER_GRANT', 'RELIEF_GRANT', 'COMPENSATION') THEN
    IF mint_dr = 0 OR mint_cr > 0 OR sink_cr > 0 OR sink_dr > 0 OR user_dr > 0 OR user_cr <> 1 THEN
      RAISE EXCEPTION '% journal % must debit MINT and credit exactly one USER account', ev, NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF ev = 'ACCOUNT_RETIREMENT' THEN
    IF sink_cr = 0 OR sink_dr > 0 OR mint_n > 0 OR user_cr > 0 OR user_dr <> 1 THEN
      RAISE EXCEPTION 'ACCOUNT_RETIREMENT journal % must debit exactly one USER account and credit SINK', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF ev = 'REVERSAL' THEN
    NULL;  -- admin correction (the owner only, see admin_journal_role); any balanced shape
  ELSIF ev = 'COMPANY_REGISTRATION' THEN
    -- 0034: at most one USER debit (the actor's, at most the fee), MINT only for a sponsorship,
    -- SINK exactly the fee, exactly one registration record
    PERFORM ledger.assert_company_registration_journal(NEW.id, actor);
  ELSE
    -- ---------------------------------------------- R2: user-driven purchases
    IF mint_n > 0 THEN
      RAISE EXCEPTION '% journal % may not post to MINT', ev, NEW.id USING ERRCODE = 'check_violation';
    END IF;
    IF sink_dr > 0 THEN
      RAISE EXCEPTION '% journal % may only credit SINK, never debit it', ev, NEW.id USING ERRCODE = 'check_violation';
    END IF;
    IF user_dr <> 1 THEN
      RAISE EXCEPTION '% journal % must debit exactly one USER account, not %', ev, NEW.id, user_dr
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT id INTO actor_acct FROM ledger.ledger_account WHERE user_id = actor AND type = 'USER';
    SELECT DISTINCT p.account_id INTO debited
      FROM ledger.posting p JOIN ledger.ledger_account a ON a.id = p.account_id
     WHERE p.journal_id = NEW.id AND a.type = 'USER' AND p.amount < 0;
    IF actor_acct IS NULL OR debited IS DISTINCT FROM actor_acct THEN
      RAISE EXCEPTION '% journal % may debit only the acting user''s own account (the signed-in session)', ev, NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM ledger.posting p WHERE p.journal_id = NEW.id AND p.account_id = actor_acct AND p.amount > 0) THEN
      RAISE EXCEPTION '% journal % both debits and credits the buyer', ev, NEW.id USING ERRCODE = 'check_violation';
    END IF;
    IF ev <> 'PURCHASE' AND user_cr > 0 THEN
      RAISE EXCEPTION '% journal % pays the platform: it may credit SINK only', ev, NEW.id
        USING ERRCODE = 'check_violation';
    END IF;

    IF ev = 'PURCHASE' THEN
      -- ------------------------------------------ R3: backed by exactly one order group
      SELECT count(*) INTO groups FROM core.order_group WHERE journal_id = NEW.id;
      IF groups <> 1 THEN
        RAISE EXCEPTION 'PURCHASE journal % must be referenced by exactly one order group (found %)', NEW.id, groups
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT * INTO grp FROM core.order_group WHERE journal_id = NEW.id;
      IF j_group IS DISTINCT FROM grp.id THEN
        RAISE EXCEPTION 'PURCHASE journal % must name its order group', NEW.id USING ERRCODE = 'check_violation';
      END IF;
      IF grp.buyer_user_id IS DISTINCT FROM actor THEN
        RAISE EXCEPTION 'PURCHASE journal %: the order group''s buyer is not the debited user', NEW.id
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT -COALESCE(SUM(amount), 0) INTO buyer_debit
        FROM ledger.posting WHERE journal_id = NEW.id AND account_id = actor_acct;
      IF buyer_debit <> grp.total_paise THEN
        RAISE EXCEPTION 'PURCHASE journal %: buyer debit % does not equal the order total %', NEW.id, buyer_debit, grp.total_paise
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (
        SELECT 1 FROM ledger.posting p JOIN ledger.ledger_account a ON a.id = p.account_id
         WHERE p.journal_id = NEW.id AND a.type = 'USER' AND p.amount > 0
           AND NOT EXISTS (
             SELECT 1 FROM core.seller_order so
               JOIN core.company c ON c.id = so.company_id
               JOIN ledger.ledger_account oa ON oa.user_id = c.owner_user_id AND oa.type = 'USER'
              WHERE so.id = p.seller_order_id AND so.order_group_id = grp.id AND oa.id = p.account_id)) THEN
        RAISE EXCEPTION 'PURCHASE journal %: a USER credit is not a seller order''s proceeds paid to its company owner', NEW.id
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (
        SELECT 1 FROM core.seller_order so
         WHERE so.order_group_id = grp.id AND so.company_id IS NOT NULL
           AND so.net_paise <> COALESCE((
             SELECT SUM(p.amount) FROM ledger.posting p JOIN ledger.ledger_account a ON a.id = p.account_id
              WHERE p.journal_id = NEW.id AND p.seller_order_id = so.id AND a.type = 'USER' AND p.amount > 0), 0)) THEN
        RAISE EXCEPTION 'PURCHASE journal %: a seller credit does not equal its seller order''s net', NEW.id
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT COALESCE(SUM(p.amount), 0) INTO sink_sum
        FROM ledger.posting p JOIN ledger.ledger_account a ON a.id = p.account_id
       WHERE p.journal_id = NEW.id AND a.type = 'SINK';
      SELECT COALESCE(SUM(so.fee_paise + so.delivery_fee_buyer_paise + so.delivery_fee_seller_paise
                          + CASE WHEN so.company_id IS NULL THEN so.net_paise ELSE 0 END), 0)
        INTO sink_due FROM core.seller_order so WHERE so.order_group_id = grp.id;
      IF sink_sum <> sink_due THEN
        RAISE EXCEPTION 'PURCHASE journal %: SINK credit % does not equal fees, delivery and seed proceeds %',
          NEW.id, sink_sum, sink_due USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  -- ------------------------------------------------ R1: grant journals
  IF ev IN ('STARTER_GRANT', 'RELIEF_GRANT') THEN
    SELECT count(*) INTO grants FROM ledger.grant_record g WHERE g.journal_id = NEW.id;
    SELECT p.account_id, a.user_id, p.amount INTO credited
      FROM ledger.posting p JOIN ledger.ledger_account a ON a.id = p.account_id
     WHERE p.journal_id = NEW.id AND a.type = 'USER' AND p.amount > 0
     LIMIT 1;
    SELECT * INTO gr FROM ledger.grant_record g WHERE g.journal_id = NEW.id LIMIT 1;
    IF grants <> 1 OR gr.type IS DISTINCT FROM (CASE ev WHEN 'STARTER_GRANT' THEN 'STARTER' ELSE 'RELIEF' END)
       OR gr.user_id IS DISTINCT FROM credited.user_id OR gr.amount IS DISTINCT FROM user_net THEN
      RAISE EXCEPTION '% journal % must be backed by exactly one grant_record for the credited user and amount',
        ev, NEW.id USING ERRCODE = 'check_violation';
    END IF;
    IF credited.user_id IS DISTINCT FROM actor THEN
      RAISE EXCEPTION '% journal % may credit only the acting user (the signed-in session)', ev, NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF ev = 'STARTER_GRANT' THEN
      IF user_net <> ledger.starter_grant_paise() THEN
        RAISE EXCEPTION 'a STARTER_GRANT is exactly % paise, not %', ledger.starter_grant_paise(), user_net
          USING ERRCODE = 'check_violation';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM ledger.ledger_account a
                      WHERE a.id = credited.account_id AND a.created_txid = txid_current()) THEN
        RAISE EXCEPTION 'STARTER_GRANT journal %: the starting grant is paid only when the account is opened', NEW.id
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM core.user_profile u
                  WHERE u.id = credited.user_id
                    AND core.identity_is_tombstoned(u.email_fingerprint, u.phone_fingerprint)) THEN
        RAISE EXCEPTION 'STARTER_GRANT journal %: a tombstoned identity gets no starting grant', NEW.id
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      IF user_net <> ledger.relief_grant_paise() THEN
        RAISE EXCEPTION 'a RELIEF_GRANT is exactly % paise, not %', ledger.relief_grant_paise(), user_net
          USING ERRCODE = 'check_violation';
      END IF;
      -- created_at is stamped by the database clock at insert (0003), never supplied, and the
      -- day must still be today at commit: a relief cannot be dated on another day
      IF gr.utc_day IS DISTINCT FROM (j_created AT TIME ZONE 'UTC')::date
         OR gr.utc_day IS DISTINCT FROM (clock_timestamp() AT TIME ZONE 'UTC')::date THEN
        RAISE EXCEPTION 'RELIEF_GRANT journal %: the grant''s UTC day must be today', NEW.id
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT count(*) INTO reliefs FROM ledger.grant_record g WHERE g.user_id = credited.user_id AND g.type = 'RELIEF';
      IF reliefs > ledger.relief_lifetime_max() THEN
        RAISE EXCEPTION 'RELIEF_GRANT journal %: at most % relief grants per user', NEW.id, ledger.relief_lifetime_max()
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT COALESCE(SUM(amount), 0) INTO prior
        FROM ledger.posting WHERE account_id = credited.account_id AND journal_id <> NEW.id;
      IF prior >= ledger.relief_wallet_ceiling_paise() THEN
        RAISE EXCEPTION 'RELIEF_GRANT journal %: relief is only for a balance below % paise (was %)',
          NEW.id, ledger.relief_wallet_ceiling_paise(), prior USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END $$;


-- The registration record matches its session, attempt, journal, company and starter warehouse.
CREATE FUNCTION core.assert_company_registration() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := core.actor_id();
  ses   core.checkout_session;
  cap   bigint;
BEGIN
  PERFORM ledger.require_read_committed();
  IF NEW.user_id IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'company registration %: only the acting user registers their own company', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ledger.journal j
                  WHERE j.id = NEW.journal_id AND j.event_type = 'COMPANY_REGISTRATION'
                    AND j.created_txid = txid_current() AND j.config_version = NEW.config_version) THEN
    RAISE EXCEPTION 'company registration %: needs a COMPANY_REGISTRATION journal of this transaction', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO ses FROM core.checkout_session cs WHERE cs.id = NEW.session_id;
  IF ses.id IS NULL OR ses.user_id IS DISTINCT FROM NEW.user_id OR ses.type <> 'COMPANY_REGISTRATION'
     OR ses.state <> 'SUCCEEDED' OR ses.total_paise <> NEW.fee_paise OR ses.config_version <> NEW.config_version THEN
    RAISE EXCEPTION 'company registration %: needs the owner''s SUCCEEDED COMPANY_REGISTRATION checkout session for this fee', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.payment_attempt pa
                  WHERE pa.id = NEW.payment_attempt_id AND pa.session_id = NEW.session_id AND pa.user_id = NEW.user_id
                    AND pa.state = 'SUCCEEDED' AND pa.authenticated_at IS NOT NULL) THEN
    RAISE EXCEPTION 'company registration %: needs an authenticated, SUCCEEDED attempt on its session', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.company c
                  WHERE c.id = NEW.company_id AND c.owner_user_id = NEW.user_id AND c.tier = 'SOLO'
                    AND c.created_txid = txid_current() AND c.handle = ses.quote ->> 'handle') THEN
    RAISE EXCEPTION 'company registration %: needs the owner''s new SOLO company with the quoted handle', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  cap := core.config_int(NEW.config_version, ARRAY['starter_warehouse_capacity'], 100);
  IF (SELECT count(*) FROM core.warehouse w WHERE w.company_id = NEW.company_id) <> 1
     OR NOT EXISTS (SELECT 1 FROM core.warehouse w
                     WHERE w.company_id = NEW.company_id AND w.kind = 'STARTER' AND w.capacity = cap
                       AND w.used = 0 AND NOT w.zap_hub) THEN
    RAISE EXCEPTION 'company registration %: the company starts with exactly one empty STARTER warehouse of capacity %', NEW.id, cap
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM core.order_group g
              WHERE g.session_id = NEW.session_id OR g.payment_attempt_id = NEW.payment_attempt_id) THEN
    RAISE EXCEPTION 'company registration %: a registration is not a product order', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.creator_entitlement ce WHERE ce.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'company registration %: needs creator access', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER registration_consistent AFTER INSERT ON core.company_registration
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.assert_company_registration();

CREATE FUNCTION core.assert_formation_sponsorship() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM ledger.require_read_committed();
  IF NOT EXISTS (SELECT 1 FROM ledger.journal j
                  WHERE j.id = NEW.journal_id AND j.event_type = 'COMPANY_REGISTRATION'
                    AND j.created_txid = txid_current()) THEN
    RAISE EXCEPTION 'formation sponsorship %: only inside a COMPANY_REGISTRATION journal of this transaction', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER sponsorship_consistent AFTER INSERT ON core.formation_sponsorship
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.assert_formation_sponsorship();

-- 0016 R5: a SUCCEEDED session or attempt needs what it paid for at commit: its order group, or,
-- for a COMPANY_REGISTRATION session, its registration record.
CREATE OR REPLACE FUNCTION core.assert_succeeded_has_order() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  kind text;
BEGIN
  PERFORM ledger.require_read_committed();
  IF NEW.state <> 'SUCCEEDED' THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'payment_attempt' THEN
    SELECT cs.type INTO kind FROM core.checkout_session cs WHERE cs.id = NEW.session_id;
  ELSE
    kind := NEW.type;
  END IF;
  IF kind = 'COMPANY_REGISTRATION' THEN
    IF NOT EXISTS (SELECT 1 FROM core.company_registration r
                    WHERE CASE TG_TABLE_NAME WHEN 'payment_attempt' THEN r.payment_attempt_id ELSE r.session_id END = NEW.id) THEN
      RAISE EXCEPTION '% % is SUCCEEDED without a company registration', TG_TABLE_NAME, NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NOT EXISTS (
       SELECT 1 FROM core.order_group g
        WHERE CASE TG_TABLE_NAME WHEN 'payment_attempt' THEN g.payment_attempt_id ELSE g.session_id END = NEW.id) THEN
    RAISE EXCEPTION '% % is SUCCEEDED without an order group', TG_TABLE_NAME, NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------- helpers
-- The handle's reservation lock subject (core.lock_actor takes a uuid).
CREATE FUNCTION core.handle_lock_key(h text) RETURNS uuid
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$ SELECT md5('store-handle:' || lower(h))::uuid $$;

-- What is wrong with a store's name and description, as [code, message]; NULL when nothing.
CREATE FUNCTION core.store_text_problem(display_name text, description text) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n text := btrim(display_name);
  d text := btrim(COALESCE(description, ''));
BEGIN
  IF n IS NULL OR char_length(n) < 3 OR char_length(n) > 40 THEN
    RETURN ARRAY['VALIDATION_FAILED', 'a store name is 3 to 40 characters'];
  END IF;
  IF n ~ '[[:cntrl:]]' THEN
    RETURN ARRAY['VALIDATION_FAILED', 'a store name may not contain control characters'];
  END IF;
  IF char_length(d) > 280 THEN
    RETURN ARRAY['VALIDATION_FAILED', 'a store description is at most 280 characters'];
  END IF;
  IF d ~ '[\x01-\x09\x0b-\x1f\x7f]' THEN
    RETURN ARRAY['VALIDATION_FAILED', 'a store description may not contain control characters'];
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION core.store_handle_problem(handle text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN handle IS NULL OR NOT core.store_handle_valid(handle) THEN
      ARRAY['VALIDATION_FAILED', 'a handle is 3 to 24 lowercase letters, digits and single inner hyphens']
    WHEN handle = ANY (core.reserved_store_handles()) THEN ARRAY['HANDLE_TAKEN', 'this handle is not available']
  END
$$;

-- The formation sponsorship the actor would get for this fee: the shortfall when the balance is
-- below the fee, the passport quiz is passed and no sponsorship was ever given; otherwise 0.
CREATE FUNCTION core.sponsorship_for(actor uuid, balance bigint, fee bigint) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN balance < fee
         AND EXISTS (SELECT 1 FROM core.passport_progress pp WHERE pp.user_id = actor AND pp.quiz_passed_at IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM core.formation_sponsorship s WHERE s.user_id = actor)
      THEN fee - balance
    ELSE 0 END
$$;

-- A live reservation of the handle by someone other than `actor`.
CREATE FUNCTION core.handle_reserved_by_other(h text, actor uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM core.handle_reservation r JOIN core.checkout_session cs ON cs.id = r.session_id
                  WHERE r.handle = h AND r.user_id <> actor AND cs.state = 'OPEN'
                    AND r.expires_at > clock_timestamp() AND cs.expires_at > clock_timestamp())
$$;

-- ---------------------------------------------------------------- quote
-- Returns {sessionId, expiresAt, handle, displayName, description, feePaise, sponsorshipPaise,
-- payablePaise, balancePaise, balanceAfterPaise (null when the balance does not cover it),
-- sufficient}. Refusals: ONBOARDING_REQUIRED, CREATOR_LOCKED, COMPANY_EXISTS, VALIDATION_FAILED,
-- HANDLE_TAKEN (registered or reserved name), HANDLE_RESERVED (another person's live quote). A
-- person holds at most one live quote: their earlier open quotes expire.
CREATE FUNCTION core.company_quote(handle text, display_name text, description text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor   uuid := core.progression_actor();
  h       text := company_quote.handle;
  n       text := btrim(company_quote.display_name);
  d       text := btrim(COALESCE(company_quote.description, ''));
  problem text[];
  cfg     int := core.current_config_id();
  fee     bigint;
  balance bigint;
  sponsor bigint;
  payable bigint;
  sid     uuid := core.uuid_v7();
  expires timestamptz;
  quote   jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.creator_entitlement ce WHERE ce.user_id = actor) THEN
    PERFORM core.fail('CREATOR_LOCKED', 'unlock creator access first');
  END IF;
  IF EXISTS (SELECT 1 FROM core.company c WHERE c.owner_user_id = actor) THEN
    PERFORM core.fail('COMPANY_EXISTS', 'you already have a company');
  END IF;
  problem := COALESCE(core.store_handle_problem(h), core.store_text_problem(n, d));
  IF problem IS NOT NULL THEN
    PERFORM core.fail(problem[1], problem[2]);
  END IF;
  -- the handle's reservation lock: one quote or registration of this handle at a time
  PERFORM core.lock_actor('core.handle_reservation', core.handle_lock_key(h));
  IF EXISTS (SELECT 1 FROM core.company c WHERE lower(c.handle) = lower(h)) THEN
    PERFORM core.fail('HANDLE_TAKEN', 'this handle is not available');
  END IF;
  IF core.handle_reserved_by_other(h, actor) THEN
    PERFORM core.fail('HANDLE_RESERVED', 'this handle is being registered by someone else; try again later');
  END IF;
  UPDATE core.checkout_session cs SET state = 'EXPIRED'
   WHERE cs.user_id = actor AND cs.type = 'COMPANY_REGISTRATION' AND cs.state = 'OPEN';

  fee := core.config_paise(cfg, ARRAY['company_registration_fee_paise'], 50000000);
  SELECT w.available_paise INTO balance FROM ledger.ledger_account la JOIN ledger.wallet w ON w.account_id = la.id
   WHERE la.user_id = actor AND la.type = 'USER';
  sponsor := core.sponsorship_for(actor, balance, fee);
  payable := fee - sponsor;
  quote := jsonb_build_object('version', 1, 'kind', 'COMPANY_REGISTRATION', 'handle', h, 'displayName', n,
                              'description', d, 'feePaise', fee::text, 'configVersion', cfg);
  INSERT INTO core.checkout_session (id, user_id, type, quote, total_paise, config_version, expires_at)
  VALUES (sid, actor, 'COMPANY_REGISTRATION', quote, fee, cfg,
          now() + make_interval(secs => core.config_int(cfg, ARRAY['company_quote_ttl_seconds'], 300)))
  RETURNING expires_at INTO expires;
  INSERT INTO core.handle_reservation (session_id, user_id, handle, expires_at) VALUES (sid, actor, h, expires);
  RETURN jsonb_build_object(
    'sessionId', sid, 'expiresAt', expires, 'handle', h, 'displayName', n, 'description', d,
    'feePaise', fee::text, 'sponsorshipPaise', sponsor::text, 'payablePaise', payable::text,
    'balancePaise', balance::text,
    'balanceAfterPaise', CASE WHEN balance >= payable THEN (balance - payable)::text END,
    'sufficient', balance >= payable);
END $$;

-- ---------------------------------------------------------------- the registration transaction
-- The locked part, run inside core.commit_company_registration's exception block: a business
-- refusal (DM001) rolls back everything it did, locks included.
CREATE FUNCTION core.company_registration_write(actor uuid, p_session_id uuid, p_attempt_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  ses        record;
  att        record;
  card       record;
  h          text;
  n          text;
  d          text;
  problem    text[];
  fee        bigint;
  acct       uuid;
  balance    bigint;
  paid       bigint;
  sponsor    bigint := 0;
  bal_after  bigint;
  cap        int;
  company_id uuid := core.uuid_v7();
  wh_id      uuid := core.uuid_v7();
  reg_id     uuid := core.uuid_v7();
  journal_id uuid := core.uuid_v7();
BEGIN
  -- the actor's progression lock (0032): one registration, quote or claim of theirs at a time
  IF core.progression_actor() IS DISTINCT FROM actor THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  -- #1 checkout session (the actor's own COMPANY_REGISTRATION one)
  SELECT cs.*, cs.expires_at <= clock_timestamp() AS expired INTO ses
    FROM core.checkout_session cs
   WHERE cs.id = p_session_id AND cs.user_id = actor AND cs.type = 'COMPANY_REGISTRATION'
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN PERFORM core.fail('NOT_FOUND', 'registration quote not found'); END IF;
  IF ses.state <> 'OPEN' THEN PERFORM core.fail('CONFLICT', 'this registration quote is no longer open'); END IF;
  IF ses.expired THEN PERFORM core.fail('CHECKOUT_EXPIRED', 'this registration quote has expired; ask for a new one'); END IF;

  SELECT pa.*, pa.authenticated_at IS NOT NULL AS authenticated INTO att
    FROM core.payment_attempt pa WHERE pa.id = p_attempt_id AND pa.user_id = actor;
  IF NOT FOUND THEN PERFORM core.fail('NOT_FOUND', 'payment attempt not found'); END IF;
  IF att.session_id <> p_session_id THEN PERFORM core.fail('VALIDATION_FAILED', 'attempt belongs to another session'); END IF;
  IF att.state <> 'PENDING' THEN PERFORM core.fail('CONFLICT', 'payment attempt is no longer pending'); END IF;
  IF NOT att.authenticated THEN
    PERFORM core.fail('PAYMENT_PENDING', 'payment is awaiting authentication');
  END IF;
  IF att.method NOT IN ('BALANCE', 'CARD') THEN PERFORM core.fail('METHOD_UNAVAILABLE', 'method not offered'); END IF;
  IF att.method = 'CARD' AND NOT core.switch_on('payments_card') THEN
    PERFORM core.fail('METHOD_UNAVAILABLE', 'card payments are switched off');
  END IF;

  -- the quote's choices (the only things taken from it); the fee comes from its configuration
  h := ses.quote ->> 'handle';
  n := ses.quote ->> 'displayName';
  d := ses.quote ->> 'description';
  -- the handle's reservation lock, then the handle itself
  PERFORM core.lock_actor('core.handle_reservation', core.handle_lock_key(COALESCE(h, '')));
  problem := COALESCE(core.store_handle_problem(h), core.store_text_problem(n, d));
  IF problem IS NOT NULL THEN PERFORM core.fail(problem[1], problem[2]); END IF;
  IF NOT EXISTS (SELECT 1 FROM core.handle_reservation r WHERE r.session_id = p_session_id AND r.handle = h) THEN
    PERFORM core.fail('CONFLICT', 'this quote holds no reservation of its handle');
  END IF;
  IF EXISTS (SELECT 1 FROM core.company c WHERE lower(c.handle) = lower(h)) THEN
    PERFORM core.fail('HANDLE_TAKEN', 'this handle is not available');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.creator_entitlement ce WHERE ce.user_id = actor) THEN
    PERFORM core.fail('CREATOR_LOCKED', 'unlock creator access first');
  END IF;
  IF EXISTS (SELECT 1 FROM core.company c WHERE c.owner_user_id = actor) THEN
    PERFORM core.fail('COMPANY_EXISTS', 'you already have a company');
  END IF;
  fee := core.config_paise(ses.config_version, ARRAY['company_registration_fee_paise'], 50000000);
  IF fee <> ses.total_paise THEN PERFORM core.fail('PRICE_CHANGED', 'the fee changed since the quote'); END IF;
  cap := core.config_int(ses.config_version, ARRAY['starter_warehouse_capacity'], 100)::int;

  -- #8 card: the actor's own
  IF att.method = 'CARD' THEN
    SELECT vc.status, vc.merchant_scope INTO card FROM core.virtual_card vc
     WHERE vc.id = att.card_id AND vc.user_id = actor FOR NO KEY UPDATE;
    IF NOT FOUND THEN PERFORM core.fail('CARD_NOT_OWNED', 'card not found for this user');
    ELSIF card.status = 'FROZEN' THEN PERFORM core.fail('CARD_FROZEN', 'card is frozen');
    ELSIF card.status <> 'ACTIVE' THEN PERFORM core.fail('CARD_REPLACED', 'card has been replaced');
    ELSIF card.merchant_scope <> 'DELULUMART' THEN PERFORM core.fail('MERCHANT_NOT_ALLOWED', 'card cannot be used here');
    END IF;
  END IF;
  -- #9 the wallet (ledger.sync_wallets locks it, waiting at most 2 s)
  SELECT la.id INTO acct FROM ledger.ledger_account la WHERE la.user_id = actor AND la.type = 'USER';
  IF acct IS NULL THEN PERFORM core.fail('ONBOARDING_REQUIRED', 'finish onboarding first'); END IF;
  PERFORM ledger.sync_wallets(ARRAY[acct]);
  SELECT w.available_paise INTO balance FROM ledger.wallet w WHERE w.account_id = acct;
  IF balance >= fee THEN
    paid := fee;
  ELSE
    sponsor := core.sponsorship_for(actor, balance, fee);
    IF sponsor = 0 THEN PERFORM core.fail('INSUFFICIENT_FUNDS', 'not enough fictional balance'); END IF;
    paid := balance;
  END IF;

  -- ------------------------------------------------ writes
  SET CONSTRAINTS ALL DEFERRED;   -- whatever mode the caller left: the checks run below, synchronously
  INSERT INTO core.company (id, owner_user_id, name, handle, description, tier)
  VALUES (company_id, actor, n, h, d, 'SOLO');
  INSERT INTO core.warehouse (id, company_id, kind, capacity, used) VALUES (wh_id, company_id, 'STARTER', cap, 0);
  INSERT INTO ledger.journal (id, event_type, config_version, idempotency_ref)
  VALUES (journal_id, 'COMPANY_REGISTRATION', ses.config_version, p_attempt_id);
  IF paid > 0 THEN
    INSERT INTO ledger.posting (journal_id, account_id, amount, memo)
    VALUES (journal_id, acct, -paid, 'Company registration');
  END IF;
  IF sponsor > 0 THEN
    INSERT INTO ledger.posting (journal_id, account_id, amount, memo)
    VALUES (journal_id, '00000000-0000-7000-8000-000000000001'::uuid, -sponsor, 'Formation sponsorship');
    INSERT INTO core.formation_sponsorship (id, user_id, journal_id, amount_paise)
    VALUES (core.uuid_v7(), actor, journal_id, sponsor);
  END IF;
  INSERT INTO ledger.posting (journal_id, account_id, amount, memo)
  VALUES (journal_id, '00000000-0000-7000-8000-000000000002'::uuid, fee, 'Company registration fee');
  INSERT INTO core.company_registration (id, company_id, user_id, session_id, payment_attempt_id, journal_id,
                                         fee_paise, paid_paise, sponsorship_paise, config_version)
  VALUES (reg_id, company_id, actor, p_session_id, p_attempt_id, journal_id, fee, paid, sponsor, ses.config_version);
  PERFORM ledger.sync_wallets(ARRAY[acct]);
  SELECT w.available_paise INTO bal_after FROM ledger.wallet w WHERE w.account_id = acct;
  IF bal_after IS DISTINCT FROM balance - paid THEN
    RAISE EXCEPTION 'registration: the wallet did not follow the postings' USING ERRCODE = 'internal_error';
  END IF;
  UPDATE core.payment_attempt SET state = 'SUCCEEDED' WHERE id = p_attempt_id;
  UPDATE core.checkout_session SET state = 'SUCCEEDED' WHERE id = p_session_id;
  -- ids and amounts only: no personal data, no names (invariant 8)
  INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
  VALUES (core.uuid_v7(), 'company_registered', company_id, jsonb_build_object(
    'companyId', company_id, 'registrationId', reg_id, 'journalId', journal_id, 'checkoutSessionId', p_session_id,
    'paymentAttemptId', p_attempt_id, 'ownerUserId', actor, 'warehouseId', wh_id, 'configVersion', ses.config_version,
    'feePaise', fee::text, 'paidPaise', paid::text, 'sponsorshipPaise', sponsor::text), 1);

  -- every structural check now; this seals the journal (R9)
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;

  RETURN jsonb_build_object('companyId', company_id, 'registrationId', reg_id, 'handle', h, 'displayName', n,
    'tier', 'SOLO', 'warehouseId', wh_id, 'feePaise', fee::text, 'paidPaise', paid::text,
    'sponsorshipPaise', sponsor::text, 'balanceAfterPaise', bal_after::text, 'paymentReference', att.reference);
END $$;

-- The pay transaction of a registration, like core.commit_purchase: {status: 'SUCCEEDED', receipt,
-- replayed} or {status: 'FAILED', error, replayed}. A business refusal records the attempt FAILED
-- and the refusal under the idempotency key and leaves no business rows; retryable conditions
-- (busy, awaiting authentication, switched off, a key reused for another request) raise.
CREATE FUNCTION core.commit_company_registration(session_id uuid, attempt_id uuid, idempotency_key text,
                                                 request_hash bytea) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor   uuid := core.actor_id();
  rec     core.idempotency_record;
  receipt jsonb;
  code    text;
  msg     text;
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  PERFORM ledger.require_read_committed();
  IF session_id IS NULL OR attempt_id IS NULL OR request_hash IS NULL THEN
    PERFORM core.fail('VALIDATION_FAILED', 'session, attempt and request hash are required');
  END IF;
  rec := core.idem_begin(actor, 'company.register', idempotency_key, request_hash);
  IF rec.status = 200 THEN
    RETURN jsonb_build_object('status', 'SUCCEEDED', 'replayed', true, 'receipt', rec.response);
  ELSIF rec.status IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'FAILED', 'replayed', true, 'error', rec.response -> 'error');
  END IF;
  IF NOT core.switch_on('purchases') THEN
    PERFORM core.fail('MAINTENANCE', 'payments are switched off');
  END IF;
  BEGIN
    receipt := core.company_registration_write(actor, commit_company_registration.session_id,
                                               commit_company_registration.attempt_id);
    UPDATE core.idempotency_record r SET status = 200, response = receipt
     WHERE r.user_id = actor AND r.command = 'company.register' AND r.key = idempotency_key;
    RETURN jsonb_build_object('status', 'SUCCEEDED', 'replayed', false, 'receipt', receipt);
  EXCEPTION WHEN SQLSTATE 'DM001' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT, code = PG_EXCEPTION_HINT;
    IF code = 'PAYMENT_PENDING' THEN
      RAISE;   -- retryable once the challenge is complete
    END IF;
  END;
  UPDATE core.idempotency_record r
     SET status = 422, response = jsonb_build_object('error', jsonb_build_object('code', code, 'message', msg))
   WHERE r.user_id = actor AND r.command = 'company.register' AND r.key = idempotency_key;
  UPDATE core.payment_attempt pa SET state = 'FAILED', failure_code = code
   WHERE pa.id = commit_company_registration.attempt_id AND pa.session_id = commit_company_registration.session_id
     AND pa.user_id = actor AND pa.state = 'PENDING';
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  RETURN jsonb_build_object('status', 'FAILED', 'replayed', false,
                            'error', jsonb_build_object('code', code, 'message', msg));
END $$;

-- ---------------------------------------------------------------- reading and editing
CREATE FUNCTION core.company_json(c core.company) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object(
    'companyId', c.id, 'handle', c.handle, 'displayName', c.name, 'description', c.description, 'tier', c.tier,
    'registeredAt', COALESCE((SELECT r.created_at FROM core.company_registration r WHERE r.company_id = c.id), c.created_at),
    'warehouses', (SELECT jsonb_build_object(
                     'count', count(*), 'capacity', COALESCE(sum(w.capacity), 0), 'used', COALESCE(sum(w.used), 0),
                     'starter', (SELECT jsonb_build_object('id', s.id, 'capacity', s.capacity, 'used', s.used)
                                   FROM core.warehouse s WHERE s.company_id = c.id AND s.kind = 'STARTER'))
                     FROM core.warehouse w WHERE w.company_id = c.id))
$$;

-- {company: {...} | null}: the actor's own company.
CREATE FUNCTION core.my_company() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('company', (SELECT core.company_json(c) FROM core.company c
                                         WHERE c.owner_user_id = core.require_actor()))
$$;

-- The owner changes the store's display name and description (NULL leaves one unchanged); the
-- handle never changes. Locks the company row (LLD §4 #4). NOT_FOUND without a company.
CREATE FUNCTION core.update_store(display_name text, description text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor   uuid := core.progression_actor();
  c       core.company;
  n       text;
  d       text;
  problem text[];
BEGIN
  SELECT * INTO c FROM core.company co WHERE co.owner_user_id = actor FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM core.fail('NOT_FOUND', 'you have no company');
  END IF;
  n := COALESCE(btrim(update_store.display_name), c.name);
  d := COALESCE(btrim(update_store.description), c.description);
  problem := core.store_text_problem(n, d);
  IF problem IS NOT NULL THEN
    PERFORM core.fail(problem[1], problem[2]);
  END IF;
  UPDATE core.company co SET name = n, description = d, updated_at = clock_timestamp() WHERE co.id = c.id
  RETURNING * INTO c;
  RETURN jsonb_build_object('company', core.company_json(c));
END $$;

-- {store: {handle, displayName, description, tier} | null}: public storefront data, no owner identity.
CREATE FUNCTION core.store_by_handle(handle text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('store', (
    SELECT jsonb_build_object('handle', c.handle, 'displayName', c.name, 'description', c.description, 'tier', c.tier)
      FROM core.company c WHERE c.handle IS NOT NULL AND lower(c.handle) = lower(store_by_handle.handle)))
$$;

-- ---------------------------------------------------------------- privileges
REVOKE ALL ON FUNCTION core.reserved_store_handles(), core.store_handle_valid(text), core.guard_company(),
  core.guard_registration_record(), ledger.assert_company_registration_journal(uuid, uuid),
  core.assert_company_registration(), core.assert_formation_sponsorship(), core.handle_lock_key(text),
  core.store_text_problem(text, text), core.store_handle_problem(text), core.sponsorship_for(uuid, bigint, bigint),
  core.handle_reserved_by_other(text, uuid), core.company_quote(text, text, text),
  core.company_registration_write(uuid, uuid, uuid), core.commit_company_registration(uuid, uuid, text, bytea),
  core.company_json(core.company), core.my_company(), core.update_store(text, text), core.store_by_handle(text)
FROM PUBLIC;
-- the money path: the checkout role only
GRANT EXECUTE ON FUNCTION core.company_quote(text, text, text),
  core.commit_company_registration(uuid, uuid, text, bytea) TO app_pay;
GRANT EXECUTE ON FUNCTION core.my_company(), core.update_store(text, text), core.store_by_handle(text) TO app_web;
