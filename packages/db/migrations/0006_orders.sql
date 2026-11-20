-- LLD §3.5: orders, ownership, shipments.

CREATE TABLE core.order_group (
  id                 uuid PRIMARY KEY,
  buyer_user_id      uuid NOT NULL,
  session_id         uuid NOT NULL UNIQUE,
  payment_attempt_id uuid NOT NULL UNIQUE,
  journal_id         uuid NOT NULL UNIQUE,
  buyer_source       text NOT NULL CHECK (buyer_source IN ('PLAYER','STAFF')),
  total_paise        bigint NOT NULL,
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
  seller_type               text NOT NULL,
  list_paise                bigint NOT NULL,
  seller_discount_paise     bigint NOT NULL DEFAULT 0,
  platform_discount_paise   bigint NOT NULL DEFAULT 0,
  fee_paise                 bigint NOT NULL,
  delivery_fee_buyer_paise  bigint NOT NULL DEFAULT 0,
  delivery_fee_seller_paise bigint NOT NULL DEFAULT 0,
  net_paise                 bigint NOT NULL,
  status                    text NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED','REVERSED')),
  qualifies_for_progression boolean NOT NULL DEFAULT true
);
CREATE INDEX seller_order_group ON core.seller_order (order_group_id);
CREATE INDEX seller_order_company ON core.seller_order (company_id);

CREATE TABLE core.order_line (
  id                      uuid PRIMARY KEY,
  seller_order_id         uuid NOT NULL REFERENCES core.seller_order(id),
  product_id              uuid NOT NULL,
  product_version_id      uuid NOT NULL,
  snapshot                jsonb NOT NULL,
  list_paise              bigint NOT NULL,
  seller_discount_paise   bigint NOT NULL,
  platform_discount_paise bigint NOT NULL,
  fee_paise               bigint NOT NULL,
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
