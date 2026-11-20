-- LLD §3.3: bank, cards, payments.

CREATE TABLE core.bank_account (
  id                uuid PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES core.user_profile(id),
  bank_code         text NOT NULL DEFAULT 'DELULU',
  ledger_account_id uuid NOT NULL UNIQUE REFERENCES ledger.ledger_account(id),
  alias             text NOT NULL UNIQUE,
  upi_style_id      text NOT NULL UNIQUE,     -- e.g. handle@delulu
  status            text NOT NULL DEFAULT 'OPEN',
  UNIQUE (user_id, bank_code)
);

CREATE TABLE core.virtual_card (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL,
  bank_account_id  uuid NOT NULL REFERENCES core.bank_account(id),
  sequence         int NOT NULL,
  card_number      char(16) NOT NULL UNIQUE CHECK (card_number ~ '^[0-9]{16}$'), -- display identifier, not a credential
  status           text NOT NULL CHECK (status IN ('ACTIVE','FROZEN','REPLACED')),
  merchant_scope   text NOT NULL DEFAULT 'DELULUMART',
  pin_hash         text,
  pin_salt         bytea,
  pin_set_at       timestamptz,
  failed_pin_count int NOT NULL DEFAULT 0,
  pin_locked_until timestamptz,
  UNIQUE (bank_account_id, sequence)
);
CREATE UNIQUE INDEX one_active_card ON core.virtual_card (bank_account_id) WHERE status IN ('ACTIVE','FROZEN');

CREATE TABLE core.checkout_session (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL,
  type           text NOT NULL CHECK (type IN ('PRODUCT_PURCHASE','COMPANY_REGISTRATION','WAREHOUSE_PURCHASE','MEMBERSHIP_PURCHASE')),
  state          text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','SUCCEEDED','CANCELED','EXPIRED')),
  quote          jsonb NOT NULL,                 -- immutable: lines, prices, versions, coupon, delivery, totals
  total_paise    bigint NOT NULL,
  config_version int NOT NULL REFERENCES core.config_version(id),
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.payment_attempt (
  id               uuid PRIMARY KEY,
  session_id       uuid NOT NULL REFERENCES core.checkout_session(id),
  user_id          uuid NOT NULL,
  method           text NOT NULL CHECK (method IN ('CARD','DELULUPAY_ID','NET_BANKING','BALANCE')),
  card_id          uuid REFERENCES core.virtual_card(id),
  state            text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','SUCCEEDED','FAILED')),
  authenticated_at timestamptz,
  failure_code     text,
  reference        text NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_success_per_session ON core.payment_attempt (session_id) WHERE state='SUCCEEDED';

CREATE TABLE core.payment_challenge (
  attempt_id    uuid PRIMARY KEY REFERENCES core.payment_attempt(id),
  kind          text NOT NULL CHECK (kind IN ('PIN','CODE','APPROVE')),
  code_hash     bytea,
  expires_at    timestamptz NOT NULL,
  attempts_used int NOT NULL DEFAULT 0,
  passed_at     timestamptz
);

CREATE TABLE core.idempotency_record (
  user_id      uuid NOT NULL,
  command      text NOT NULL,
  key          text NOT NULL,
  request_hash bytea NOT NULL,
  status       int,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, command, key)
);
CREATE INDEX idempotency_created ON core.idempotency_record (created_at);
