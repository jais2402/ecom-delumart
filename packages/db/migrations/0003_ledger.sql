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
  created_at      timestamptz NOT NULL DEFAULT now()
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
  user_id    uuid NOT NULL,
  journal_id uuid NOT NULL REFERENCES ledger.journal(id),
  type       text NOT NULL CHECK (type IN ('STARTER','RELIEF','COMPENSATION','PROMO')),
  amount     bigint NOT NULL,
  utc_day    date,
  CHECK (type <> 'RELIEF' OR utc_day IS NOT NULL)
);
CREATE UNIQUE INDEX one_starter ON ledger.grant_record (user_id) WHERE type='STARTER';
CREATE UNIQUE INDEX one_relief_per_day ON ledger.grant_record (user_id, utc_day) WHERE type='RELIEF';

-- Every journal sums to zero, checked at commit (deferred), once per inserted posting.
CREATE FUNCTION ledger.assert_zero_sum() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT COALESCE(SUM(amount),0) FROM ledger.posting WHERE journal_id = NEW.journal_id) <> 0 THEN
    RAISE EXCEPTION 'journal % does not sum to zero', NEW.journal_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER posting_zero_sum AFTER INSERT ON ledger.posting
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.assert_zero_sum();

-- Append-only: rows are never updated or deleted (nor truncated); corrections are new rows.
CREATE TRIGGER no_change BEFORE UPDATE OR DELETE ON ledger.posting
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON ledger.posting
  FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();
CREATE TRIGGER no_change BEFORE UPDATE OR DELETE ON ledger.journal
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON ledger.journal
  FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();
