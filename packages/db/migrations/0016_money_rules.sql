-- Structural money rules (security review). Enforced by the database for EVERY role,
-- the money-command role app_pay included, so that they still hold if the web process
-- (which holds the app_pay credential, see 0011) is fully compromised.
--
--  R1  MINT appears only in STARTER_GRANT (exactly 100,000,000,000 paise, one STARTER
--      grant_record for the acting user, account opened in the same transaction, not
--      tombstoned), RELIEF_GRANT (exactly ledger.relief_grant_paise(), one per user per
--      UTC day, at most ledger.relief_lifetime_max() per user, only while the wallet was
--      below ledger.relief_wallet_ceiling_paise() before the grant), and COMPENSATION /
--      REVERSAL, which only app_jobs (or the owner) may create.
--  R2  PURCHASE, COMPANY_REGISTRATION, WAREHOUSE_PURCHASE, MEMBERSHIP: exactly one USER
--      account is debited and it is the ledger account of app.user_id; SINK is only
--      credited; in PURCHASE every other USER posting is a seller credit, the other
--      three types credit SINK only.
--  R3  A PURCHASE journal is referenced at commit by exactly one order group of the
--      acting buyer whose total equals the buyer's debit; every seller credit is tagged
--      with a seller order of that group and goes to its company owner's account and
--      equals its net; SINK receives exactly fees + delivery fees + seed proceeds.
--  R4  An order group references a SUCCEEDED attempt and session of its buyer and a
--      PURCHASE journal of the same transaction, and is priced from the database:
--      current product versions and prices, fees and delivery fees from its
--      configuration version, delivery speed eligibility, merchant-funded delivery,
--      a genuine, applicable coupon. Seller orders, lines, shipments, ownership, coupon
--      redemptions, entitlement unlocks and unit issues only join an order group created
--      in the same transaction. Stock and coupon counters equal the rows they count.
--  R5  payment_attempt PENDING -> SUCCEEDED | FAILED and checkout_session OPEN ->
--      SUCCEEDED | CANCELED | EXPIRED only; SUCCEEDED needs its order group at commit.
--  R6  A CARD attempt is never inserted authenticated; authentication is a later update,
--      stamped with the database clock. Cards and sessions belong to the attempt's user.
--
--  R7  Every check runs only at READ COMMITTED (ledger.require_read_committed, 0003), so
--      each of its statements reads the latest committed rows; the order-group check also
--      locks the products, the coupon and the switches it reads (FOR SHARE) so they cannot
--      change between the check and the commit. Expiry (session, coupon window,
--      membership) is judged by clock_timestamp(), not by the transaction start, so a
--      long-open transaction cannot keep something expired alive.
--  R8  COMPANY_REGISTRATION, WAREHOUSE_PURCHASE and MEMBERSHIP are refused for app_pay and
--      app_web until the records and checks that back them exist (see 0014).
--
-- Every check is a SECURITY DEFINER function (owned by the migration role, so it sees
-- rows that RLS hides from the caller) run as a deferred constraint trigger, so it
-- judges the transaction's final state at commit regardless of statement order.

-- ---------------------------------------------------------------- fixed amounts
-- Product rules, not configuration: no configuration row may change what a grant mints.
CREATE FUNCTION ledger.starter_grant_paise() RETURNS bigint LANGUAGE sql IMMUTABLE AS $$ SELECT 100000000000::bigint $$;
CREATE FUNCTION ledger.relief_grant_paise() RETURNS bigint LANGUAGE sql IMMUTABLE AS $$ SELECT 100000000::bigint $$;
CREATE FUNCTION ledger.relief_wallet_ceiling_paise() RETURNS bigint LANGUAGE sql IMMUTABLE AS $$ SELECT 100000000::bigint $$;
CREATE FUNCTION ledger.relief_lifetime_max() RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT 7 $$;

-- ---------------------------------------------------------------- configuration readers
-- Mirror parseConfig() in packages/db/src/checkout.ts: money is a decimal string,
-- whole numbers are a JSON integer or a digit string; anything else is the default.
CREATE FUNCTION core.config_paise(cfg_id int, path text[], dflt bigint) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN jsonb_typeof(v) = 'string' AND (v #>> '{}') ~ '^[0-9]{1,18}$' THEN (v #>> '{}')::bigint
              ELSE dflt END
    FROM (SELECT (SELECT values #> path FROM core.config_version WHERE id = cfg_id) AS v) x
$$;
CREATE FUNCTION core.config_int(cfg_id int, path text[], dflt bigint) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN jsonb_typeof(v) IN ('string', 'number') AND (v #>> '{}') ~ '^[0-9]{1,15}$' THEN (v #>> '{}')::bigint
              ELSE dflt END
    FROM (SELECT (SELECT values #> path FROM core.config_version WHERE id = cfg_id) AS v) x
$$;

-- Delivery fee for a speed under a configuration, member-adjusted (LLD §5.1 step 4).
CREATE FUNCTION core.delivery_fee_paise(cfg_id int, speed text, is_member boolean) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN NOT is_member THEN base WHEN speed = 'ZAP' THEN base / 2 ELSE 0 END
    FROM (SELECT core.config_paise(cfg_id, ARRAY['delivery_fee_paise', speed],
                   CASE speed WHEN 'STANDARD' THEN 100000 WHEN 'EXPRESS' THEN 1000000 ELSE 5000000 END) AS base) x
$$;

-- ---------------------------------------------------------------- "created in this transaction"
-- order_group and ledger_account record their creating transaction (never caller-supplied),
-- like ledger.journal.created_txid (0003).
ALTER TABLE core.order_group ADD COLUMN created_txid bigint NOT NULL DEFAULT txid_current();
ALTER TABLE ledger.ledger_account ADD COLUMN created_txid bigint NOT NULL DEFAULT txid_current();
CREATE TRIGGER stamp_txid BEFORE INSERT ON core.order_group
  FOR EACH ROW EXECUTE FUNCTION ledger.stamp_journal_txid();
CREATE TRIGGER stamp_txid BEFORE INSERT ON ledger.ledger_account
  FOR EACH ROW EXECUTE FUNCTION ledger.stamp_journal_txid();

-- ---------------------------------------------------------------- references (deferred: checked at commit)
ALTER TABLE core.order_group
  ADD CONSTRAINT order_group_journal_fk FOREIGN KEY (journal_id) REFERENCES ledger.journal(id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT order_group_session_fk FOREIGN KEY (session_id) REFERENCES core.checkout_session(id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT order_group_attempt_fk FOREIGN KEY (payment_attempt_id) REFERENCES core.payment_attempt(id)
    DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE core.coupon_redemption
  ADD CONSTRAINT coupon_redemption_group_fk FOREIGN KEY (order_group_id) REFERENCES core.order_group(id)
    DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE core.ownership
  ADD CONSTRAINT ownership_line_fk FOREIGN KEY (order_line_id) REFERENCES core.order_line(id)
    DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------- R1/R2/R3: journal rules
-- Admin journal types: only app_jobs or the owner (superuser / member of migrator) may
-- insert them. A BEFORE trigger runs as the inserting role, so current_user is the
-- caller. (The RLS insert policy for app_pay, 0014, already excludes them.)
CREATE FUNCTION ledger.assert_admin_journal_role() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.event_type IN ('COMPENSATION', 'REVERSAL', 'ACCOUNT_RETIREMENT')
     AND current_user <> 'app_jobs'
     AND NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false)
     AND NOT pg_has_role(current_user, 'migrator', 'MEMBER') THEN
    RAISE EXCEPTION '% journals are created only by the job runner (app_jobs), not %', NEW.event_type, current_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- R8: nothing backs these yet, so the application roles may not create them at all
  IF NEW.event_type IN ('COMPANY_REGISTRATION', 'WAREHOUSE_PURCHASE', 'MEMBERSHIP')
     AND current_user IN ('app_pay', 'app_web') THEN
    RAISE EXCEPTION '% journals are not available until their backing records and checks exist', NEW.event_type
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER admin_journal_role BEFORE INSERT ON ledger.journal
  FOR EACH ROW EXECUTE FUNCTION ledger.assert_admin_journal_role();

-- Replaces 0003's journal_structure and 0014's journal_purchase_mint with one check.
DROP TRIGGER journal_structure ON ledger.journal;
DROP TRIGGER journal_purchase_mint ON ledger.journal;
DROP FUNCTION ledger.assert_journal_structure();
DROP FUNCTION ledger.assert_purchase_mint();

CREATE FUNCTION ledger.assert_journal_rules() RETURNS trigger
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
  actor     uuid := nullif(current_setting('app.user_id', true), '')::uuid;
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
    NULL;  -- admin correction (app_jobs only, see admin_journal_role); any balanced shape
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
      RAISE EXCEPTION '% journal % may debit only the acting user''s own account (app.user_id)', ev, NEW.id
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
      RAISE EXCEPTION '% journal % may credit only the acting user (app.user_id)', ev, NEW.id
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
CREATE CONSTRAINT TRIGGER journal_rules AFTER INSERT ON ledger.journal
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.assert_journal_rules();

-- ---------------------------------------------------------------- R4: FLAT coupon split
-- Mirrors discountsOn() for a FLAT amount in packages/core/src/pricing: each base may be
-- discounted down to 10,000 paise (₹100); the amount is split in proportion to the bases,
-- each share floored and the remainder added to the last open base; a share above a base's
-- room is re-split across the bases that still have room, until the amount is given or no
-- base has room. Returns one discount per base, in order. Numeric arithmetic: the product of
-- an amount and a base can exceed bigint.
CREATE FUNCTION core.flat_split(amount bigint, bases bigint[]) RETURNS bigint[]
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n         int := COALESCE(cardinality(bases), 0);
  rooms     numeric[];
  given     numeric[];
  remaining numeric := amount;
  pass      numeric;
  open_idx  int[];
  sum_w     numeric;
  share     numeric;
  allocated numeric;
  take      numeric;
  k         int;
  i         int;
BEGIN
  IF n = 0 THEN
    RETURN ARRAY[]::bigint[];
  END IF;
  rooms := ARRAY(SELECT GREATEST(b - 10000, 0)::numeric FROM unnest(bases) WITH ORDINALITY AS x(b, o) ORDER BY o);
  given := array_fill(0::numeric, ARRAY[n]);
  WHILE remaining > 0 LOOP
    open_idx := ARRAY(SELECT j FROM generate_series(1, n) j WHERE given[j] < rooms[j] ORDER BY j);
    EXIT WHEN cardinality(open_idx) = 0;
    sum_w := (SELECT SUM(bases[j]) FROM unnest(open_idx) j);
    pass := remaining;          -- the shares of this pass split what remained at its start
    allocated := 0;
    FOR k IN 1 .. cardinality(open_idx) LOOP
      i := open_idx[k];
      IF k < cardinality(open_idx) THEN
        share := div(pass * bases[i], sum_w);
        allocated := allocated + share;
      ELSE
        share := pass - allocated;   -- the last share takes the remainder
      END IF;
      take := LEAST(share, rooms[i] - given[i]);
      given[i] := given[i] + take;
      remaining := remaining - take;
    END LOOP;
  END LOOP;
  RETURN given::bigint[];
END $$;

-- ---------------------------------------------------------------- R4: the order group, priced from the database
CREATE FUNCTION core.assert_order_group() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  g        core.order_group%ROWTYPE;
  actor    uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  j        record;
  s        record;
  a        record;
  sor      record;
  ln       record;
  r        record;
  cp       record;
  member   boolean;
  fee_pct  bigint;
  ttl      bigint;
  fee      bigint;
  funded   boolean;
  sos      int := 0;
  buyer_total bigint := 0;
  eligible_list bigint;
  eligible_room bigint;
  discount bigint;
  redemptions int;
  now_ts   timestamptz := clock_timestamp();   -- expiry is judged by the clock, not the transaction start
  is_test  boolean;
  d_ms     bigint;
  shp      record;
  bases    bigint[];
  sds      bigint[];
BEGIN
  PERFORM ledger.require_read_committed();
  SELECT * INTO g FROM core.order_group WHERE id = NEW.id;
  IF g.buyer_user_id IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'order group %: the buyer must be the acting user (app.user_id)', g.id USING ERRCODE = 'check_violation';
  END IF;

  -- What can change under a concurrent transaction is locked before it is read (canonical
  -- order, LLD §4: coupon, then products; then the switches), so it cannot change between
  -- this check and the commit. pay() already holds the coupon and products FOR UPDATE.
  PERFORM 1 FROM core.coupon c
   WHERE c.id IN (SELECT cr.coupon_id FROM core.coupon_redemption cr WHERE cr.order_group_id = g.id)
   ORDER BY c.id FOR SHARE;
  PERFORM 1 FROM core.product p
   WHERE p.id IN (SELECT l.product_id FROM core.order_line l JOIN core.seller_order so ON so.id = l.seller_order_id
                   WHERE so.order_group_id = g.id)
   ORDER BY p.id FOR SHARE;
  PERFORM 1 FROM core.system_switch sw WHERE sw.name IN ('payments_card', 'purchases') ORDER BY sw.name FOR SHARE;

  SELECT u.is_test_account INTO is_test FROM core.user_profile u WHERE u.id = g.buyer_user_id;
  IF g.buyer_source IS DISTINCT FROM (CASE WHEN is_test THEN 'STAFF' ELSE 'PLAYER' END) THEN
    RAISE EXCEPTION 'order group %: buyer_source must be STAFF for a test account and PLAYER otherwise', g.id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO j FROM ledger.journal WHERE id = g.journal_id;
  IF NOT FOUND OR j.event_type <> 'PURCHASE' OR j.created_txid <> txid_current()
     OR j.order_group_id IS DISTINCT FROM g.id OR j.config_version <> g.config_version THEN
    RAISE EXCEPTION 'order group % needs a PURCHASE journal for it, created in the same transaction', g.id
      USING ERRCODE = 'check_violation';
  END IF;

  ttl := core.config_int(g.config_version, ARRAY['checkout_session_ttl_seconds'], 300);
  SELECT * INTO s FROM core.checkout_session WHERE id = g.session_id;
  IF NOT FOUND OR s.user_id <> g.buyer_user_id OR s.type <> 'PRODUCT_PURCHASE' OR s.state <> 'SUCCEEDED'
     OR s.config_version <> g.config_version OR s.total_paise <> g.total_paise
     OR s.expires_at <= now_ts OR s.expires_at > s.created_at + make_interval(secs => ttl)
     OR s.config_version IS DISTINCT FROM (SELECT cv.id FROM core.config_version cv
                                            WHERE cv.effective_from <= s.created_at ORDER BY cv.id DESC LIMIT 1) THEN
    RAISE EXCEPTION 'order group % needs the buyer''s unexpired PRODUCT_PURCHASE session, SUCCEEDED, for the same total and configuration',
      g.id USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO a FROM core.payment_attempt WHERE id = g.payment_attempt_id;
  IF NOT FOUND OR a.user_id <> g.buyer_user_id OR a.session_id <> g.session_id OR a.state <> 'SUCCEEDED'
     OR a.authenticated_at IS NULL THEN
    RAISE EXCEPTION 'order group % needs the buyer''s authenticated, SUCCEEDED payment attempt for its session', g.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF a.method = 'CARD' AND NOT EXISTS (
       SELECT 1 FROM core.virtual_card vc
        WHERE vc.id = a.card_id AND vc.user_id = g.buyer_user_id AND vc.status = 'ACTIVE'
          AND vc.merchant_scope = 'DELULUMART') THEN
    RAISE EXCEPTION 'order group %: paid with a card that is not the buyer''s active DeluluMart card', g.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.system_switch sw WHERE sw.name = 'purchases' AND sw.enabled)
     OR (a.method = 'CARD' AND NOT EXISTS (SELECT 1 FROM core.system_switch sw WHERE sw.name = 'payments_card' AND sw.enabled)) THEN
    RAISE EXCEPTION 'order group %: purchases (or card payments) are switched off', g.id USING ERRCODE = 'check_violation';
  END IF;

  member := EXISTS (SELECT 1 FROM core.membership m
                     WHERE m.user_id = g.buyer_user_id AND m.starts_at <= now_ts AND m.ends_at > now_ts);
  fee_pct := core.config_int(g.config_version, ARRAY['fee_percent'], 5);

  -- lines are numbered 0..n-1 in the pricing function's input order (the FLAT split uses it)
  IF EXISTS (SELECT 1 FROM (SELECT count(*) AS n, count(DISTINCT l.line_no) AS d, min(l.line_no) AS lo, max(l.line_no) AS hi
                              FROM core.order_line l JOIN core.seller_order so ON so.id = l.seller_order_id
                             WHERE so.order_group_id = g.id) x
              WHERE x.n > 0 AND (x.d <> x.n OR x.lo <> 0 OR x.hi <> x.n - 1)) THEN
    RAISE EXCEPTION 'order group %: order lines must be numbered 0..n-1 in pricing order', g.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- ------------------------------------------------ lines, priced from product rows
  FOR ln IN
    SELECT l.*, so.company_id AS so_company, so.seller_type AS so_type,
           p.company_id AS p_company, p.seller_type AS p_type, p.status AS p_status,
           p.current_version_id, p.inventory_mode,
           v.product_id AS v_product, v.price_paise AS v_price,
           u.id AS unit_id, u.product_id AS u_product, u.state AS u_state, u.order_line_id AS u_line, u.serial AS u_serial,
           (SELECT count(*) FROM core.ownership o
             WHERE o.order_line_id = l.id AND o.user_id = g.buyer_user_id AND o.product_id = l.product_id) AS owned
      FROM core.order_line l
      JOIN core.seller_order so ON so.id = l.seller_order_id
      LEFT JOIN core.product p ON p.id = l.product_id
      LEFT JOIN core.product_version v ON v.id = l.product_version_id
      LEFT JOIN core.inventory_unit u ON u.id = l.inventory_unit_id
     WHERE so.order_group_id = g.id
  LOOP
    IF ln.p_status IS DISTINCT FROM 'PUBLISHED' OR ln.current_version_id IS DISTINCT FROM ln.product_version_id
       OR ln.v_product IS DISTINCT FROM ln.product_id OR ln.v_price IS DISTINCT FROM ln.list_paise
       OR ln.p_company IS DISTINCT FROM ln.so_company OR ln.p_type IS DISTINCT FROM ln.so_type THEN
      RAISE EXCEPTION 'order line %: not the current price of a published product of this seller', ln.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF ln.platform_discount_paise <> 0
       OR ln.seller_discount_paise > GREATEST(ln.list_paise - 10000, 0)
       OR ln.fee_paise <> (CASE WHEN ln.so_type = 'SEED' THEN 0
                                ELSE (ln.list_paise - ln.seller_discount_paise) * fee_pct / 100 END) THEN
      RAISE EXCEPTION 'order line %: discount or fee does not follow the pricing rules', ln.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF ln.owned <> 1 THEN
      RAISE EXCEPTION 'order line %: needs exactly one ownership for the buyer', ln.id USING ERRCODE = 'check_violation';
    END IF;
    IF ln.inventory_mode IN ('STANDARD_STOCKED', 'EXCLUSIVE') THEN
      IF ln.unit_id IS NULL OR ln.u_product <> ln.product_id OR ln.u_state <> 'ISSUED' OR ln.u_line IS DISTINCT FROM ln.id
         OR (ln.inventory_mode = 'EXCLUSIVE' AND ln.edition_serial IS DISTINCT FROM ln.u_serial) THEN
        RAISE EXCEPTION 'order line %: a stocked product needs its own issued unit', ln.id USING ERRCODE = 'check_violation';
      END IF;
    ELSIF ln.inventory_unit_id IS NOT NULL THEN
      RAISE EXCEPTION 'order line %: unlimited seed stock issues no unit', ln.id USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  -- ------------------------------------------------ seller orders: sums, delivery, proceeds
  FOR sor IN
    SELECT o.*,
           (SELECT count(*) FROM core.order_line l WHERE l.seller_order_id = o.id) AS lines,
           (SELECT COALESCE(SUM(l.list_paise), 0) FROM core.order_line l WHERE l.seller_order_id = o.id) AS l_list,
           (SELECT COALESCE(SUM(l.seller_discount_paise), 0) FROM core.order_line l WHERE l.seller_order_id = o.id) AS l_sd,
           (SELECT COALESCE(SUM(l.platform_discount_paise), 0) FROM core.order_line l WHERE l.seller_order_id = o.id) AS l_pd,
           (SELECT COALESCE(SUM(l.fee_paise), 0) FROM core.order_line l WHERE l.seller_order_id = o.id) AS l_fee,
           (SELECT bool_and(p.free_standard_delivery) FROM core.order_line l JOIN core.product p ON p.id = l.product_id
             WHERE l.seller_order_id = o.id) AS all_free,
           (SELECT bool_and(p.offers_express) FROM core.order_line l JOIN core.product p ON p.id = l.product_id
             WHERE l.seller_order_id = o.id) AS all_express,
           (SELECT bool_and((p.seller_type = 'SEED' AND p.zap_flag)
                            OR EXISTS (SELECT 1 FROM core.inventory_unit u JOIN core.warehouse w ON w.id = u.warehouse_id
                                        WHERE u.id = l.inventory_unit_id AND w.zap_hub))
              FROM core.order_line l JOIN core.product p ON p.id = l.product_id
             WHERE l.seller_order_id = o.id) AS all_zap,
           (SELECT count(*) FROM core.shipment sh WHERE sh.seller_order_id = o.id) AS shipments,
           (SELECT sh.speed FROM core.shipment sh WHERE sh.seller_order_id = o.id LIMIT 1) AS speed,
           (SELECT c.owner_user_id FROM core.company c WHERE c.id = o.company_id) AS owner
      FROM core.seller_order o WHERE o.order_group_id = g.id
  LOOP
    sos := sos + 1;
    IF sor.buyer_user_id <> g.buyer_user_id OR sor.lines = 0 OR sor.status <> 'COMPLETED'
       OR sor.list_paise <> sor.l_list OR sor.seller_discount_paise <> sor.l_sd
       OR sor.platform_discount_paise <> sor.l_pd OR sor.fee_paise <> sor.l_fee THEN
      RAISE EXCEPTION 'seller order %: amounts must be the sums of its lines', sor.id USING ERRCODE = 'check_violation';
    END IF;
    IF sor.company_id IS NOT NULL AND (sor.owner IS NULL OR sor.owner = g.buyer_user_id) THEN
      RAISE EXCEPTION 'seller order %: no purchase from an unknown or one''s own company', sor.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF sor.shipments <> 1 THEN
      RAISE EXCEPTION 'seller order %: needs exactly one shipment', sor.id USING ERRCODE = 'check_violation';
    END IF;
    IF (sor.speed = 'EXPRESS' AND NOT sor.all_express) OR (sor.speed = 'ZAP' AND NOT sor.all_zap) THEN
      RAISE EXCEPTION 'seller order %: % delivery is not offered for these products', sor.id, sor.speed
        USING ERRCODE = 'check_violation';
    END IF;
    fee := core.delivery_fee_paise(g.config_version, sor.speed, member);
    funded := sor.speed = 'STANDARD' AND sor.all_free;
    IF sor.delivery_fee_seller_paise <> (CASE WHEN funded THEN fee ELSE 0 END)
       OR sor.delivery_fee_buyer_paise <> (CASE WHEN funded THEN 0 ELSE fee END) THEN
      RAISE EXCEPTION 'seller order %: delivery fees do not follow the configuration (speed %, merchant-funded %)',
        sor.id, sor.speed, funded USING ERRCODE = 'check_violation';
    END IF;
    IF sor.net_paise <> sor.list_paise - sor.seller_discount_paise - sor.fee_paise - sor.delivery_fee_seller_paise THEN
      RAISE EXCEPTION 'seller order %: net must be list - seller discount - fee - seller-funded delivery', sor.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF sor.qualifies_for_progression AND (is_test OR sor.owner = g.buyer_user_id) THEN
      RAISE EXCEPTION 'seller order %: a test account''s or own-company purchase does not qualify for progression', sor.id
        USING ERRCODE = 'check_violation';
    END IF;
    -- the shipment schedule (LLD §5.7): placed at the journal's time, then 10/30/70/100% of
    -- the configured duration for the speed; within one second
    SELECT * INTO shp FROM core.shipment WHERE seller_order_id = sor.id;
    d_ms := core.config_int(g.config_version, ARRAY['delivery_duration_ms', sor.speed],
                            CASE sor.speed WHEN 'STANDARD' THEN 86400000 WHEN 'EXPRESS' THEN 7200000 ELSE 600000 END);
    IF shp.cancelled_at IS NOT NULL OR shp.delivered_notified
       OR abs(extract(epoch FROM shp.placed_at - j.created_at)) > 1
       OR abs(extract(epoch FROM shp.packed_at - (j.created_at + (d_ms * 10 / 100) * interval '1 millisecond'))) > 1
       OR abs(extract(epoch FROM shp.shipped_at - (j.created_at + (d_ms * 30 / 100) * interval '1 millisecond'))) > 1
       OR abs(extract(epoch FROM shp.out_at - (j.created_at + (d_ms * 70 / 100) * interval '1 millisecond'))) > 1
       OR abs(extract(epoch FROM shp.delivered_at - (j.created_at + d_ms * interval '1 millisecond'))) > 1 THEN
      RAISE EXCEPTION 'seller order %: the shipment does not follow the % schedule from the purchase time', sor.id, sor.speed
        USING ERRCODE = 'check_violation';
    END IF;
    buyer_total := buyer_total + sor.list_paise - sor.seller_discount_paise - sor.platform_discount_paise
                   + sor.delivery_fee_buyer_paise;
  END LOOP;
  IF sos = 0 OR buyer_total <> g.total_paise THEN
    RAISE EXCEPTION 'order group %: total % does not equal its seller orders (%)', g.id, g.total_paise, buyer_total
      USING ERRCODE = 'check_violation';
  END IF;

  -- ------------------------------------------------ coupon: genuine, applicable, exactly applied
  SELECT count(*) INTO redemptions FROM core.coupon_redemption WHERE order_group_id = g.id;
  IF redemptions = 0 THEN
    IF EXISTS (SELECT 1 FROM core.seller_order o WHERE o.order_group_id = g.id AND o.seller_discount_paise <> 0) THEN
      RAISE EXCEPTION 'order group %: a seller discount needs a coupon redemption', g.id USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT * INTO r FROM core.coupon_redemption WHERE order_group_id = g.id LIMIT 1;
    SELECT * INTO cp FROM core.coupon WHERE id = r.coupon_id;
    IF redemptions > 1 OR r.user_id <> g.buyer_user_id OR cp.scope <> 'MERCHANT' OR cp.status <> 'ACTIVE'
       OR (cp.starts_at IS NOT NULL AND cp.starts_at > now_ts) OR (cp.ends_at IS NOT NULL AND cp.ends_at <= now_ts)
       OR EXISTS (SELECT 1 FROM core.company c WHERE c.id = cp.company_id AND c.owner_user_id = g.buyer_user_id)
       OR NOT EXISTS (SELECT 1 FROM core.seller_order o WHERE o.order_group_id = g.id AND o.company_id = cp.company_id)
       OR EXISTS (SELECT 1 FROM core.seller_order o WHERE o.order_group_id = g.id
                     AND o.company_id IS DISTINCT FROM cp.company_id AND o.seller_discount_paise <> 0) THEN
      RAISE EXCEPTION 'order group %: the coupon redemption is not a valid merchant coupon of a seller in the order', g.id
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT COALESCE(SUM(l.list_paise), 0), COALESCE(SUM(GREATEST(l.list_paise - 10000, 0)), 0),
           COALESCE(SUM(l.seller_discount_paise), 0),
           array_agg(l.list_paise ORDER BY l.line_no), array_agg(l.seller_discount_paise ORDER BY l.line_no)
      INTO eligible_list, eligible_room, discount, bases, sds
      FROM core.order_line l JOIN core.seller_order o ON o.id = l.seller_order_id
     WHERE o.order_group_id = g.id AND o.company_id = cp.company_id;
    IF eligible_list < cp.min_spend_paise THEN
      RAISE EXCEPTION 'order group %: the order does not reach coupon %''s minimum spend', g.id, cp.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF r.discount_paise <> discount THEN
      RAISE EXCEPTION 'order group %: the redemption records % but the lines give %', g.id, r.discount_paise, discount
        USING ERRCODE = 'check_violation';
    END IF;
    IF (cp.kind = 'FLAT' AND discount <> LEAST(cp.value, eligible_room))
       OR (cp.kind = 'PERCENT' AND EXISTS (
             SELECT 1 FROM core.order_line l JOIN core.seller_order o ON o.id = l.seller_order_id
              WHERE o.order_group_id = g.id AND o.company_id = cp.company_id
                AND l.seller_discount_paise <> LEAST(l.list_paise * cp.value / 100, GREATEST(l.list_paise - 10000, 0)))) THEN
      RAISE EXCEPTION 'order group %: the seller discount is not what coupon % gives', g.id, cp.id
        USING ERRCODE = 'check_violation';
    END IF;
    -- a FLAT amount is split across the lines exactly as the pricing function splits it
    IF cp.kind = 'FLAT' AND core.flat_split(cp.value, bases) IS DISTINCT FROM sds THEN
      RAISE EXCEPTION 'order group %: coupon %''s FLAT discount is not split across the lines as the pricing function splits it',
        g.id, cp.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER order_group_consistent AFTER INSERT ON core.order_group
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.assert_order_group();

-- ---------------------------------------------------------------- R4: parts join only a group made in this transaction
CREATE FUNCTION core.assert_joins_new_group() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  grp   uuid;
  buyer uuid;
  ok    boolean;
BEGIN
  PERFORM ledger.require_read_committed();
  CASE TG_TABLE_NAME
    WHEN 'seller_order' THEN
      SELECT g.id INTO grp FROM core.order_group g
       WHERE g.id = NEW.order_group_id AND g.buyer_user_id = NEW.buyer_user_id AND g.created_txid = txid_current();
    WHEN 'order_line' THEN
      SELECT g.id INTO grp FROM core.seller_order so JOIN core.order_group g ON g.id = so.order_group_id
       WHERE so.id = NEW.seller_order_id AND g.created_txid = txid_current();
    WHEN 'shipment' THEN
      SELECT g.id INTO grp FROM core.seller_order so JOIN core.order_group g ON g.id = so.order_group_id
       WHERE so.id = NEW.seller_order_id AND g.created_txid = txid_current();
    WHEN 'ownership' THEN
      SELECT g.id INTO grp FROM core.order_line l
        JOIN core.seller_order so ON so.id = l.seller_order_id
        JOIN core.order_group g ON g.id = so.order_group_id
       WHERE l.id = NEW.order_line_id AND l.product_id = NEW.product_id
         AND g.buyer_user_id = NEW.user_id AND g.created_txid = txid_current();
    WHEN 'coupon_redemption' THEN
      SELECT g.id INTO grp FROM core.order_group g
       WHERE g.id = NEW.order_group_id AND g.buyer_user_id = NEW.user_id AND g.created_txid = txid_current();
    WHEN 'creator_entitlement' THEN
      SELECT g.id, g.buyer_user_id INTO grp, buyer FROM core.order_group g
       WHERE g.id = NEW.evidence_order_group_id AND g.buyer_user_id = NEW.user_id AND g.created_txid = txid_current();
      IF grp IS NOT NULL THEN
        SELECT w.available_paise < core.config_paise(g.config_version, ARRAY['creator_threshold_paise'], 1000000000)
          INTO ok
          FROM core.order_group g
          JOIN ledger.ledger_account la ON la.user_id = g.buyer_user_id AND la.type = 'USER'
          JOIN ledger.wallet w ON w.account_id = la.id
         WHERE g.id = grp;
        IF ok IS NOT TRUE THEN
          RAISE EXCEPTION 'creator entitlement for %: the wallet is not below the creator threshold', NEW.user_id
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
  END CASE;
  IF grp IS NULL THEN
    RAISE EXCEPTION '% row must belong to an order group of the same user created in this transaction', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER joins_new_group AFTER INSERT ON core.seller_order
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.assert_joins_new_group();
CREATE CONSTRAINT TRIGGER joins_new_group AFTER INSERT ON core.order_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.assert_joins_new_group();
CREATE CONSTRAINT TRIGGER joins_new_group AFTER INSERT ON core.shipment
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.assert_joins_new_group();
CREATE CONSTRAINT TRIGGER joins_new_group AFTER INSERT ON core.ownership
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.assert_joins_new_group();
CREATE CONSTRAINT TRIGGER joins_new_group AFTER INSERT ON core.coupon_redemption
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.assert_joins_new_group();
CREATE CONSTRAINT TRIGGER joins_new_group AFTER INSERT ON core.creator_entitlement
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.assert_joins_new_group();

-- A unit becomes ISSUED only from AVAILABLE, and only for an order line of an order
-- group created in this transaction that names this unit and its product.
CREATE FUNCTION core.assert_unit_issue() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM ledger.require_read_committed();
  IF NEW.state = 'ISSUED' AND (TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM 'ISSUED'
                               OR OLD.order_line_id IS DISTINCT FROM NEW.order_line_id) THEN
    IF (TG_OP = 'UPDATE' AND OLD.state <> 'AVAILABLE') OR NOT EXISTS (
         SELECT 1 FROM core.order_line l
           JOIN core.seller_order so ON so.id = l.seller_order_id
           JOIN core.order_group g ON g.id = so.order_group_id
          WHERE l.id = NEW.order_line_id AND l.inventory_unit_id = NEW.id AND l.product_id = NEW.product_id
            AND g.created_txid = txid_current()) THEN
      RAISE EXCEPTION 'inventory unit % may become ISSUED only from AVAILABLE, with an order line created in this transaction',
        NEW.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER unit_issue AFTER INSERT OR UPDATE ON core.inventory_unit
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.assert_unit_issue();

-- ---------------------------------------------------------------- R4: counters equal what they count
CREATE FUNCTION core.assert_counters() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  pid  uuid;
  wids uuid[];
  cid  uuid;
  bad  text;
BEGIN
  PERFORM ledger.require_read_committed();
  -- plpgsql resolves NEW.<field> when an expression is planned, so pick fields per table
  IF TG_TABLE_NAME = 'product' THEN
    pid := NEW.id;
  ELSIF TG_TABLE_NAME = 'warehouse' THEN
    wids := ARRAY[NEW.id];
  ELSIF TG_TABLE_NAME = 'inventory_unit' THEN
    pid := NEW.product_id;
    wids := ARRAY[NEW.warehouse_id];
    IF TG_OP = 'UPDATE' THEN
      wids := wids || OLD.warehouse_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'coupon' THEN
    cid := NEW.id;
  ELSE
    cid := NEW.coupon_id;
  END IF;

  IF pid IS NOT NULL THEN
    SELECT p.id::text INTO bad FROM core.product p
     WHERE p.id = pid AND p.inventory_mode IN ('STANDARD_STOCKED', 'EXCLUSIVE')
       AND p.available_units <> (SELECT count(*) FROM core.inventory_unit u
                                  WHERE u.product_id = p.id AND u.state = 'AVAILABLE');
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'product %: available_units must equal its AVAILABLE units', bad USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF wids IS NOT NULL THEN
    SELECT w.id::text INTO bad FROM core.warehouse w
     WHERE w.id = ANY(wids)
       AND w.used <> (SELECT count(*) FROM core.inventory_unit u WHERE u.warehouse_id = w.id AND u.state = 'AVAILABLE')
     LIMIT 1;
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'warehouse %: used must equal its AVAILABLE units', bad USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF cid IS NOT NULL THEN
    SELECT c.id::text INTO bad FROM core.coupon c
     WHERE c.id = cid AND c.redeemed <> (SELECT count(*) FROM core.coupon_redemption r WHERE r.coupon_id = c.id);
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'coupon %: redeemed must equal its redemptions', bad USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER counters AFTER INSERT OR UPDATE ON core.product
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.assert_counters();
CREATE CONSTRAINT TRIGGER counters AFTER INSERT OR UPDATE ON core.warehouse
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.assert_counters();
CREATE CONSTRAINT TRIGGER counters AFTER INSERT OR UPDATE ON core.inventory_unit
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.assert_counters();
CREATE CONSTRAINT TRIGGER counters AFTER INSERT OR UPDATE ON core.coupon
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.assert_counters();
CREATE CONSTRAINT TRIGGER counters AFTER INSERT ON core.coupon_redemption
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.assert_counters();

-- ---------------------------------------------------------------- R5/R6: attempts and sessions
CREATE FUNCTION core.guard_payment_attempt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM ledger.require_read_committed();
  IF TG_OP = 'INSERT' THEN
    IF NEW.method = 'CARD' AND NEW.authenticated_at IS NOT NULL THEN
      RAISE EXCEPTION 'a CARD attempt is created unauthenticated; authentication is a separate step'
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.method = 'CARD') <> (NEW.card_id IS NOT NULL) THEN
      RAISE EXCEPTION 'a card is given for CARD attempts and only for them' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.card_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM core.virtual_card c WHERE c.id = NEW.card_id AND c.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'the card does not belong to the paying user' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM core.checkout_session s WHERE s.id = NEW.session_id AND s.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'the checkout session does not belong to the paying user' USING ERRCODE = 'check_violation';
    END IF;
    -- balance payments are authenticated by the signed-in session itself, at creation
    NEW.authenticated_at := CASE WHEN NEW.method = 'BALANCE' THEN now() END;
    RETURN NEW;
  END IF;

  IF (NEW.session_id, NEW.user_id, NEW.method, NEW.card_id, NEW.reference, NEW.created_at)
     IS DISTINCT FROM (OLD.session_id, OLD.user_id, OLD.method, OLD.card_id, OLD.reference, OLD.created_at) THEN
    RAISE EXCEPTION 'payment attempt % is immutable except for its state and authentication', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state <> 'PENDING' AND (NEW.state, NEW.authenticated_at, NEW.failure_code)
                                IS DISTINCT FROM (OLD.state, OLD.authenticated_at, OLD.failure_code) THEN
    RAISE EXCEPTION 'payment attempt % is % and final', OLD.id, OLD.state USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state <> OLD.state AND NEW.state NOT IN ('SUCCEEDED', 'FAILED') THEN
    RAISE EXCEPTION 'payment attempt % may move only PENDING -> SUCCEEDED or FAILED', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.authenticated_at IS DISTINCT FROM OLD.authenticated_at THEN
    IF OLD.authenticated_at IS NOT NULL OR NEW.authenticated_at IS NULL OR OLD.method <> 'CARD' THEN
      RAISE EXCEPTION 'payment attempt %: only a pending CARD attempt is authenticated, once', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.authenticated_at := now();   -- recorded by the database clock, not the caller
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard BEFORE INSERT OR UPDATE ON core.payment_attempt
  FOR EACH ROW EXECUTE FUNCTION core.guard_payment_attempt();

CREATE FUNCTION core.guard_checkout_session() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM ledger.require_read_committed();
  IF (NEW.user_id, NEW.type, NEW.quote, NEW.total_paise, NEW.config_version, NEW.created_at)
     IS DISTINCT FROM (OLD.user_id, OLD.type, OLD.quote, OLD.total_paise, OLD.config_version, OLD.created_at) THEN
    RAISE EXCEPTION 'checkout session % is immutable except for its state', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state <> OLD.state AND (OLD.state <> 'OPEN' OR NEW.state NOT IN ('SUCCEEDED', 'CANCELED', 'EXPIRED')) THEN
    RAISE EXCEPTION 'checkout session % may move only OPEN -> SUCCEEDED, CANCELED or EXPIRED', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard BEFORE UPDATE ON core.checkout_session
  FOR EACH ROW EXECUTE FUNCTION core.guard_checkout_session();

-- SUCCEEDED needs the order group (and so, by R4, its journal) at commit.
CREATE FUNCTION core.assert_succeeded_has_order() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM ledger.require_read_committed();
  IF NEW.state = 'SUCCEEDED' AND NOT EXISTS (
       SELECT 1 FROM core.order_group g
        WHERE CASE TG_TABLE_NAME WHEN 'payment_attempt' THEN g.payment_attempt_id ELSE g.session_id END = NEW.id) THEN
    RAISE EXCEPTION '% % is SUCCEEDED without an order group', TG_TABLE_NAME, NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER succeeded_has_order AFTER INSERT OR UPDATE ON core.payment_attempt
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.assert_succeeded_has_order();
CREATE CONSTRAINT TRIGGER succeeded_has_order AFTER INSERT OR UPDATE ON core.checkout_session
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.assert_succeeded_has_order();

-- ---------------------------------------------------------------- wallet sync, narrowed
-- 0003's ledger.sync_wallets locked and synced any wallet. It now accepts only wallets
-- the caller has a reason to touch: the acting user's own, any account that received a
-- posting in this transaction, and the owners of companies with a published product
-- (pay locks seller wallets before posting, LLD §4 #9). Anything else is refused, so
-- the function cannot be used to hold arbitrary users' wallet locks. It never waits more
-- than 2 s for a wallet lock, whatever lock_timeout the caller set (SET clause below): a
-- caller cannot make it queue unboundedly behind someone holding a wallet.
CREATE OR REPLACE FUNCTION ledger.sync_wallets(account_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
BEGIN
  PERFORM ledger.require_read_committed();
  IF EXISTS (
    SELECT 1 FROM unnest(account_ids) AS x(id)
     WHERE NOT EXISTS (
       SELECT 1 FROM ledger.ledger_account a
        WHERE a.id = x.id AND a.type = 'USER'
          AND (a.user_id = nullif(current_setting('app.user_id', true), '')::uuid
            OR EXISTS (SELECT 1 FROM ledger.posting p JOIN ledger.journal j ON j.id = p.journal_id
                        WHERE p.account_id = a.id AND j.created_txid = txid_current())
            OR EXISTS (SELECT 1 FROM core.company c JOIN core.product pr ON pr.company_id = c.id
                        WHERE c.owner_user_id = a.user_id AND pr.status = 'PUBLISHED')))) THEN
    RAISE EXCEPTION 'sync_wallets: not the acting user''s, a seller''s or a just-posted account'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1 FROM ledger.wallet WHERE account_id = ANY(account_ids) ORDER BY account_id FOR UPDATE;
  UPDATE ledger.wallet w
     SET available_paise = s.posted, version = w.version + 1
    FROM (SELECT a.id, COALESCE((SELECT SUM(p.amount) FROM ledger.posting p WHERE p.account_id = a.id), 0) AS posted
            FROM unnest(account_ids) AS a(id)) s
   WHERE w.account_id = s.id AND w.available_paise <> s.posted;
END $$;

REVOKE ALL ON FUNCTION
  ledger.assert_admin_journal_role(), ledger.assert_journal_rules(), core.assert_order_group(),
  core.assert_joins_new_group(), core.assert_unit_issue(), core.assert_counters(),
  core.guard_payment_attempt(), core.guard_checkout_session(), core.assert_succeeded_has_order(),
  core.config_paise(int, text[], bigint), core.config_int(int, text[], bigint),
  core.delivery_fee_paise(int, text, boolean), core.flat_split(bigint, bigint[]),
  ledger.starter_grant_paise(), ledger.relief_grant_paise(), ledger.relief_wallet_ceiling_paise(),
  ledger.relief_lifetime_max()
FROM PUBLIC;
