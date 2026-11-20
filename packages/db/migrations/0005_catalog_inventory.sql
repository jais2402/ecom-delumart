-- LLD §3.4: catalog and inventory.

CREATE TABLE core.product (
  id                     uuid PRIMARY KEY,
  company_id             uuid,                       -- null for platform seed
  seller_type            text NOT NULL CHECK (seller_type IN ('USER','SEED')),
  status                 text NOT NULL CHECK (status IN ('DRAFT','SCREENING','NEEDS_REVIEW','PUBLISHED','REJECTED','HIDDEN','ARCHIVED')),
  current_version_id     uuid,
  category               text NOT NULL,
  inventory_mode         text NOT NULL CHECK (inventory_mode IN ('STANDARD_STOCKED','EXCLUSIVE','UNLIMITED_SEED')),
  exclusive_supply       int,
  available_units        int NOT NULL DEFAULT 0 CHECK (available_units >= 0),
  offers_express         boolean NOT NULL DEFAULT false,
  free_standard_delivery boolean NOT NULL DEFAULT false,
  zap_flag               boolean NOT NULL DEFAULT false,                    -- seed items only
  published_at           timestamptz,
  CHECK ((seller_type='SEED') = (company_id IS NULL))
);

CREATE TABLE core.product_version (                           -- immutable
  id             uuid PRIMARY KEY,
  product_id     uuid NOT NULL REFERENCES core.product(id),
  revision       int NOT NULL,
  name           text NOT NULL,
  hook           text,
  description    text NOT NULL,
  alt_text       text NOT NULL,
  template_id    int NOT NULL,
  price_paise    bigint NOT NULL CHECK (price_paise BETWEEN 10000 AND 100000000000 AND price_paise % 100 = 0),
  author_user_id uuid,
  search         tsvector,
  UNIQUE (product_id, revision)
);
CREATE INDEX product_version_search ON core.product_version USING gin (search);

CREATE TABLE core.warehouse (
  id         uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('STARTER','PURCHASED')),
  capacity   int NOT NULL DEFAULT 100 CHECK (capacity >= 0),
  used       int NOT NULL DEFAULT 0,
  zap_hub    boolean NOT NULL DEFAULT false,
  CONSTRAINT warehouse_used_within_capacity CHECK (used BETWEEN 0 AND capacity)
);
CREATE UNIQUE INDEX one_starter_wh ON core.warehouse (company_id) WHERE kind='STARTER';
CREATE UNIQUE INDEX one_zap_hub   ON core.warehouse (company_id) WHERE zap_hub;

CREATE TABLE core.inventory_unit (
  id            uuid PRIMARY KEY,
  product_id    uuid NOT NULL REFERENCES core.product(id),
  warehouse_id  uuid NOT NULL REFERENCES core.warehouse(id),
  serial        int,                                             -- exclusive editions
  state         text NOT NULL CHECK (state IN ('AVAILABLE','ISSUED','RETIRED_UNSOLD','REVOKED_ISSUED')),
  order_line_id uuid,
  UNIQUE (product_id, serial)
);
CREATE INDEX unit_pick ON core.inventory_unit (product_id, warehouse_id, serial) WHERE state='AVAILABLE';
