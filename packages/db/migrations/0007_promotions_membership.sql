-- LLD §3.6: promotions and membership.

CREATE TABLE core.promo_campaign (
  id           uuid PRIMARY KEY,
  name         text NOT NULL,
  budget_paise bigint NOT NULL CHECK (budget_paise >= 0),
  spent_paise  bigint NOT NULL DEFAULT 0,
  status       text NOT NULL CHECK (status IN ('DRAFT','ACTIVE','PAUSED','ENDED')),
  CONSTRAINT campaign_spent_within_budget CHECK (spent_paise BETWEEN 0 AND budget_paise)
);

CREATE TABLE core.coupon (
  id              uuid PRIMARY KEY,
  scope           text NOT NULL CHECK (scope IN ('MERCHANT','PLATFORM')),
  company_id      uuid,
  campaign_id     uuid REFERENCES core.promo_campaign(id),
  code_normalised text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('PERCENT','FLAT')),
  value           bigint NOT NULL CHECK (value > 0),
  min_spend_paise bigint NOT NULL DEFAULT 0,
  starts_at       timestamptz,
  ends_at         timestamptz,
  max_redemptions int,
  redeemed        int NOT NULL DEFAULT 0 CHECK (redeemed >= 0),
  is_public       boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','ENDED','ARCHIVED')),
  CHECK ((scope='MERCHANT') = (company_id IS NOT NULL)),
  CHECK (kind <> 'PERCENT' OR value BETWEEN 1 AND 90),
  CONSTRAINT coupon_redeemed_within_cap CHECK (max_redemptions IS NULL OR redeemed <= max_redemptions)
);
CREATE UNIQUE INDEX coupon_code ON core.coupon
  (COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid), code_normalised) WHERE status='ACTIVE';

CREATE TABLE core.coupon_redemption (
  coupon_id      uuid NOT NULL REFERENCES core.coupon(id),
  user_id        uuid NOT NULL,
  order_group_id uuid NOT NULL,
  discount_paise bigint NOT NULL CHECK (discount_paise >= 0),
  PRIMARY KEY (coupon_id, user_id)
);

CREATE TABLE core.membership (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  journal_id uuid NOT NULL UNIQUE,
  CHECK (ends_at > starts_at),
  -- no overlapping periods for one user (btree_gist provides uuid WITH =)
  CONSTRAINT membership_no_overlap EXCLUDE USING gist (user_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
);
