-- LLD §3.5: orders, ownership, shipments.

CREATE TABLE core.order_group (
  id                 uuid PRIMARY KEY,
  buyer_user_id      uuid NOT NULL,
  session_id         uuid NOT NULL UNIQUE,
  payment_attempt_id uuid NOT NULL UNIQUE,
  journal_id         uuid NOT NULL UNIQUE,
  buyer_source       text NOT NULL CHECK (buyer_source IN ('PLAYER','STAFF')),
  total_paise        bigint NOT NULL CHECK (total_paise >= 0),
  config_version     int NOT NULL,
  geo                jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_group_buyer ON core.order_group (buyer_user_id, created_at);

CREATE TABLE core.seller_order (
  id                        uuid PRIMARY KEY,
  order_group_id            uuid NOT NULL REFERENCES core.order_group(id),
  buyer_user_id             uuid NOT NULL,
  company_id                uuid,
  seller_type               text NOT NULL CHECK (seller_type IN ('USER','SEED')),
  list_paise                bigint NOT NULL CHECK (list_paise >= 0),
  seller_discount_paise     bigint NOT NULL DEFAULT 0 CHECK (seller_discount_paise >= 0),
  platform_discount_paise   bigint NOT NULL DEFAULT 0 CHECK (platform_discount_paise >= 0),
  fee_paise                 bigint NOT NULL CHECK (fee_paise >= 0),
  delivery_fee_buyer_paise  bigint NOT NULL DEFAULT 0 CHECK (delivery_fee_buyer_paise >= 0),
  delivery_fee_seller_paise bigint NOT NULL DEFAULT 0 CHECK (delivery_fee_seller_paise >= 0),
  net_paise                 bigint NOT NULL CHECK (net_paise >= 0),
  status                    text NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED','REVERSED')),
  qualifies_for_progression boolean NOT NULL DEFAULT true,
  CHECK ((seller_type = 'SEED') = (company_id IS NULL))
);
CREATE INDEX seller_order_group ON core.seller_order (order_group_id);
CREATE INDEX seller_order_company ON core.seller_order (company_id);

CREATE TABLE core.order_line (
  id                      uuid PRIMARY KEY,
  seller_order_id         uuid NOT NULL REFERENCES core.seller_order(id),
  product_id              uuid NOT NULL,
  product_version_id      uuid NOT NULL,
  snapshot                jsonb NOT NULL,
  list_paise              bigint NOT NULL CHECK (list_paise >= 0),
  seller_discount_paise   bigint NOT NULL CHECK (seller_discount_paise >= 0),
  platform_discount_paise bigint NOT NULL CHECK (platform_discount_paise >= 0),
  fee_paise               bigint NOT NULL CHECK (fee_paise >= 0),
  inventory_unit_id       uuid,
  edition_serial          int
);
CREATE INDEX order_line_seller_order ON core.order_line (seller_order_id);

CREATE TABLE core.ownership (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL,
  product_id    uuid NOT NULL,
  order_line_id uuid NOT NULL UNIQUE,
  state         text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','REVOKED','UNAVAILABLE')),
  UNIQUE (user_id, product_id)                                 -- includes revoked: no rebuy
);

CREATE TABLE core.shipment (
  id                 uuid PRIMARY KEY,
  seller_order_id    uuid NOT NULL UNIQUE REFERENCES core.seller_order(id),
  speed              text NOT NULL CHECK (speed IN ('STANDARD','EXPRESS','ZAP')),
  address_id         uuid REFERENCES private.address(id) ON DELETE SET NULL,
  placed_at          timestamptz NOT NULL,
  packed_at          timestamptz NOT NULL,
  shipped_at         timestamptz NOT NULL,
  out_at             timestamptz NOT NULL,
  delivered_at       timestamptz NOT NULL,
  cancelled_at       timestamptz,
  delivered_notified boolean NOT NULL DEFAULT false
);
CREATE INDEX shipment_due ON core.shipment (delivered_at) WHERE NOT delivered_notified AND cancelled_at IS NULL;

-- Ledger attribution references (the ledger is created before the order tables).
-- Deferred: the pay transaction writes its journal and postings before the order
-- group and seller orders they point at.
ALTER TABLE ledger.posting ADD CONSTRAINT posting_seller_order_fk
  FOREIGN KEY (seller_order_id) REFERENCES core.seller_order(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ledger.journal ADD CONSTRAINT journal_order_group_fk
  FOREIGN KEY (order_group_id) REFERENCES core.order_group(id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX posting_seller_order ON ledger.posting (seller_order_id) WHERE seller_order_id IS NOT NULL;
