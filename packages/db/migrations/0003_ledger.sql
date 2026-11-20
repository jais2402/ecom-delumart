-- LLD §3.2: ledger, zero-sum and append-only enforcement.

CREATE TABLE ledger.ledger_account (
  id       uuid PRIMARY KEY,
  type     text NOT NULL CHECK (type IN ('USER','MINT','SINK')),
  user_id  uuid UNIQUE REFERENCES core.user_profile(id),
  CHECK ((type='USER') = (user_id IS NOT NULL))
);
-- exactly one MINT and one SINK account
CREATE UNIQUE INDEX one_system_account ON ledger.ledger_account (type) WHERE type <> 'USER';

CREATE TABLE ledger.journal (
  id              uuid PRIMARY KEY,
  event_type      text NOT NULL CHECK (event_type IN
    ('STARTER_GRANT','RELIEF_GRANT','PURCHASE','COMPANY_REGISTRATION','WAREHOUSE_PURCHASE',
     'MEMBERSHIP','REVERSAL','COMPENSATION','ACCOUNT_RETIREMENT')),
  config_version  int  NOT NULL REFERENCES core.config_version(id),
  funding_bank_account_id uuid,
  order_group_id  uuid,
  reversal_of     uuid REFERENCES ledger.journal(id),
  idempotency_ref uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- the transaction that created the journal; stamped by trigger, never caller-supplied.
  -- Postings are accepted only from this transaction (a committed journal is closed).
  created_txid    bigint NOT NULL DEFAULT txid_current()
);

CREATE TABLE ledger.posting (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  journal_id      uuid NOT NULL REFERENCES ledger.journal(id),
  account_id      uuid NOT NULL REFERENCES ledger.ledger_account(id),
  amount          bigint NOT NULL CHECK (amount <> 0),   -- signed paise
  seller_order_id uuid,                                  -- attribution for statements
  memo            text NOT NULL
);
CREATE INDEX posting_account ON ledger.posting (account_id, id);
CREATE INDEX posting_journal ON ledger.posting (journal_id);

CREATE TABLE ledger.wallet (
  account_id       uuid PRIMARY KEY REFERENCES ledger.ledger_account(id),
  available_paise  bigint NOT NULL CHECK (available_paise >= 0),
  version          bigint NOT NULL DEFAULT 0,
  reconciled_at    timestamptz
);
-- wallet rows exist for USER accounts only; MINT and SINK have no cached balance

CREATE TABLE ledger.grant_record (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES core.user_profile(id),
  journal_id uuid NOT NULL REFERENCES ledger.journal(id),
  type       text NOT NULL CHECK (type IN ('STARTER','RELIEF','COMPENSATION','PROMO')),
  amount     bigint NOT NULL CHECK (amount > 0),
  utc_day    date,
  CHECK (type <> 'RELIEF' OR utc_day IS NOT NULL)
);
CREATE UNIQUE INDEX one_starter ON ledger.grant_record (user_id) WHERE type='STARTER';
CREATE UNIQUE INDEX one_relief_per_day ON ledger.grant_record (user_id, utc_day) WHERE type='RELIEF';

-- Ledger integrity triggers. Functions that read ledger rows are SECURITY DEFINER
-- (owned by the migration/owner role, which RLS does not filter) so that the checks
-- see every posting even when the inserting role's RLS policies hide other accounts.

-- Every journal sums to zero, checked at commit (deferred), once per inserted posting.
CREATE FUNCTION ledger.assert_zero_sum() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (SELECT COALESCE(SUM(amount),0) FROM ledger.posting WHERE journal_id = NEW.journal_id) <> 0 THEN
    RAISE EXCEPTION 'journal % does not sum to zero', NEW.journal_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER posting_zero_sum AFTER INSERT ON ledger.posting
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.assert_zero_sum();

-- journal.created_txid is always the inserting transaction, whatever the caller sent.
CREATE FUNCTION ledger.stamp_journal_txid() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW.created_txid := txid_current();
  RETURN NEW;
END $$;
CREATE TRIGGER stamp_txid BEFORE INSERT ON ledger.journal
  FOR EACH ROW EXECUTE FUNCTION ledger.stamp_journal_txid();

-- Postings may only be added by the transaction that created their journal. Runs
-- after the row's CHECK and foreign-key checks, immediately (not deferred).
CREATE FUNCTION ledger.assert_posting_same_tx() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ledger.journal
                  WHERE id = NEW.journal_id AND created_txid = txid_current()) THEN
    RAISE EXCEPTION 'journal % was created in an earlier transaction and is closed; post a new journal instead',
      NEW.journal_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER posting_same_tx AFTER INSERT ON ledger.posting
  FOR EACH ROW EXECUTE FUNCTION ledger.assert_posting_same_tx();

-- Journal structure, checked at commit once per journal:
--  * at least two postings;
--  * STARTER_GRANT, RELIEF_GRANT, COMPENSATION: MINT debited, exactly one USER account
--    credited, nothing else;
--  * ACCOUNT_RETIREMENT: exactly one USER account debited, SINK credited, nothing else;
--  * every other type: MINT only debited and SINK only credited, except REVERSAL;
--    USER accounts either way;
--  * STARTER_GRANT / RELIEF_GRANT: backed by exactly one grant_record of that kind, for
--    the credited user and the credited amount (so a grant journal cannot be minted
--    without the grant record and its uniqueness and amount rules).
CREATE FUNCTION ledger.assert_journal_structure() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ev        text;
  n         int;
  mint_cr   int;
  mint_dr   int;
  sink_cr   int;
  sink_dr   int;
  user_cr   int;
  user_dr   int;
  user_net  bigint;
  grants    int;
  matching  int;
BEGIN
  SELECT event_type INTO ev FROM ledger.journal WHERE id = NEW.id;
  SELECT count(*),
         count(*) FILTER (WHERE a.type = 'MINT' AND p.amount > 0),
         count(*) FILTER (WHERE a.type = 'MINT' AND p.amount < 0),
         count(*) FILTER (WHERE a.type = 'SINK' AND p.amount > 0),
         count(*) FILTER (WHERE a.type = 'SINK' AND p.amount < 0),
         count(DISTINCT p.account_id) FILTER (WHERE a.type = 'USER' AND p.amount > 0),
         count(DISTINCT p.account_id) FILTER (WHERE a.type = 'USER' AND p.amount < 0),
         COALESCE(SUM(p.amount) FILTER (WHERE a.type = 'USER'), 0)
    INTO n, mint_cr, mint_dr, sink_cr, sink_dr, user_cr, user_dr, user_net
    FROM ledger.posting p JOIN ledger.ledger_account a ON a.id = p.account_id
   WHERE p.journal_id = NEW.id;

  IF n < 2 THEN
    RAISE EXCEPTION 'journal % (%) has % posting(s); a journal needs at least two postings', NEW.id, ev, n
      USING ERRCODE = 'check_violation';
  END IF;

  IF ev IN ('STARTER_GRANT', 'RELIEF_GRANT', 'COMPENSATION') THEN
    IF mint_dr = 0 OR mint_cr > 0 OR sink_cr > 0 OR sink_dr > 0 OR user_dr > 0 OR user_cr <> 1 THEN
      RAISE EXCEPTION '% journal % must debit MINT and credit exactly one USER account', ev, NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF ev = 'ACCOUNT_RETIREMENT' THEN
    IF sink_cr = 0 OR sink_dr > 0 OR mint_cr > 0 OR mint_dr > 0 OR user_cr > 0 OR user_dr <> 1 THEN
      RAISE EXCEPTION 'ACCOUNT_RETIREMENT journal % must debit exactly one USER account and credit SINK', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF ev <> 'REVERSAL' THEN
    IF mint_cr > 0 OR sink_dr > 0 THEN
      RAISE EXCEPTION '% journal % may only debit MINT and only credit SINK', ev, NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF ev IN ('STARTER_GRANT', 'RELIEF_GRANT') THEN
    SELECT count(*) INTO grants FROM ledger.grant_record g WHERE g.journal_id = NEW.id;
    SELECT count(*) INTO matching
      FROM ledger.grant_record g
      JOIN ledger.ledger_account a ON a.user_id = g.user_id AND a.type = 'USER'
     WHERE g.journal_id = NEW.id
       AND g.type = CASE ev WHEN 'STARTER_GRANT' THEN 'STARTER' ELSE 'RELIEF' END
       AND g.amount = user_net
       AND EXISTS (SELECT 1 FROM ledger.posting p WHERE p.journal_id = NEW.id AND p.account_id = a.id);
    IF grants <> 1 OR matching <> 1 THEN
      RAISE EXCEPTION '% journal % must be backed by exactly one grant_record for the credited user and amount',
        ev, NEW.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_structure AFTER INSERT ON ledger.journal
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.assert_journal_structure();

-- A wallet is a cache of its account's postings: at commit, every wallet row inserted
-- or updated in the transaction must equal the sum of that account's postings, and
-- wallets exist only for USER accounts (MINT and SINK have no cached balance).
CREATE FUNCTION ledger.assert_wallet_matches_ledger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  acct_type text;
  balance   bigint;
  posted    bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.account_id IS DISTINCT FROM NEW.account_id THEN
    RAISE EXCEPTION 'wallet account_id cannot change' USING ERRCODE = 'check_violation';
  END IF;
  SELECT a.type, w.available_paise INTO acct_type, balance
    FROM ledger.wallet w JOIN ledger.ledger_account a ON a.id = w.account_id
   WHERE w.account_id = NEW.account_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF acct_type <> 'USER' THEN
    RAISE EXCEPTION 'wallet % belongs to a % account; wallets exist only for USER accounts',
      NEW.account_id, acct_type USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(SUM(amount), 0) INTO posted FROM ledger.posting WHERE account_id = NEW.account_id;
  IF balance <> posted THEN
    RAISE EXCEPTION 'wallet % balance % does not equal the sum of its postings %', NEW.account_id, balance, posted
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER wallet_matches_ledger AFTER INSERT OR UPDATE ON ledger.wallet
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.assert_wallet_matches_ledger();

-- The STARTER grant is a fixed amount (₹100 crore). An AFTER trigger rather than a
-- CHECK so that a duplicate STARTER still reports the one_starter unique violation.
CREATE FUNCTION ledger.assert_starter_amount() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.type = 'STARTER' AND NEW.amount <> 100000000000 THEN
    RAISE EXCEPTION 'a STARTER grant is exactly 100000000000 paise, not %', NEW.amount
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER starter_amount AFTER INSERT OR UPDATE ON ledger.grant_record
  FOR EACH ROW EXECUTE FUNCTION ledger.assert_starter_amount();

-- Lets a transaction (e.g. the buyer's pay transaction) bring wallets it cannot read
-- under RLS, such as sellers', in line with the postings it has just written: locks
-- the wallets in ascending account order (LLD §4 #9) and sets each to the sum of its
-- account's postings. It cannot move money, only make the cache match the ledger,
-- returns nothing, and the CHECK (available_paise >= 0) still applies.
CREATE FUNCTION ledger.sync_wallets(account_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM ledger.wallet WHERE account_id = ANY(account_ids) ORDER BY account_id FOR UPDATE;
  UPDATE ledger.wallet w
     SET available_paise = s.posted, version = w.version + 1
    FROM (SELECT a.id, COALESCE((SELECT SUM(p.amount) FROM ledger.posting p WHERE p.account_id = a.id), 0) AS posted
            FROM unnest(account_ids) AS a(id)) s
   WHERE w.account_id = s.id AND w.available_paise <> s.posted;
END $$;

-- Append-only: rows are never updated or deleted (nor truncated); corrections are new rows.
CREATE TRIGGER no_change BEFORE UPDATE OR DELETE ON ledger.posting
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON ledger.posting
  FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();
CREATE TRIGGER no_change BEFORE UPDATE OR DELETE ON ledger.journal
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON ledger.journal
  FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();
