-- LLD §3.7 (configuration, created first because the ledger references it),
-- §3.1 identity, and the minimal §3.9 tables that §3.1 references.

CREATE TABLE core.config_version (
  id             int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  values         jsonb NOT NULL,
  effective_from timestamptz NOT NULL,
  created_by     uuid,
  note           text
);

CREATE TABLE core.system_switch (
  name       text PRIMARY KEY,
  enabled    boolean NOT NULL,
  updated_at timestamptz NOT NULL
);
-- names: purchases, signup_grants, publication, npc, payments_card, payments_netbanking, ...

-- §3.9 (minimal): referenced by private.address.
CREATE TABLE core.fictional_locality (
  id   int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE core.fictional_landmark (
  id          int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  locality_id int NOT NULL REFERENCES core.fictional_locality(id),
  name        text NOT NULL,
  UNIQUE (locality_id, name)
);

CREATE TABLE core.user_profile (
  -- = auth.users.id: a profile exists only for a user the auth service created (on Supabase the
  -- migration role needs REFERENCES on auth.users)
  id                uuid PRIMARY KEY REFERENCES auth.users(id),
  handle            text UNIQUE CHECK (handle ~ '^[a-z0-9-]{3,24}$'),
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','DELETED')),
  role              text NOT NULL DEFAULT 'PLAYER' CHECK (role IN ('PLAYER','SUPER_ADMIN')),
  is_test_account   boolean NOT NULL DEFAULT false,    -- buyer_source STAFF
  email_fingerprint bytea NOT NULL UNIQUE,             -- HMAC of normalised email
  phone_fingerprint bytea UNIQUE,                      -- HMAC of E.164; null until verified
  phone_verified_at timestamptz,
  is_adult          boolean NOT NULL DEFAULT false,    -- derived from birthdate at onboarding
  research_opt_out  boolean NOT NULL DEFAULT false,
  privacy           jsonb NOT NULL DEFAULT '{}',
  provisioned_at    timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- at most one Super Admin row in this release; the row is created by migration, never by the application
CREATE UNIQUE INDEX one_super_admin ON core.user_profile (role) WHERE role = 'SUPER_ADMIN';

-- §3.9 (minimal): the company aggregate; the full column set arrives with the company module.
CREATE TABLE core.company (
  id            uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES core.user_profile(id),
  name          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE private.user_secret (                      -- web role only
  user_id        uuid PRIMARY KEY REFERENCES core.user_profile(id) ON DELETE CASCADE,
  birthdate_enc  bytea NOT NULL,                        -- AES-256-GCM, key id prefixed
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE private.address (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES core.user_profile(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('REAL','FICTIONAL')),
  label       text NOT NULL CHECK (label IN ('HOME','WORK','OTHER')),
  payload_enc bytea,                                     -- REAL: encrypted JSON {name,line1,line2,city,state,pincode}
  locality_id int REFERENCES core.fictional_locality(id), -- FICTIONAL
  landmark_id int REFERENCES core.fictional_landmark(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind='REAL' AND payload_enc IS NOT NULL) OR (kind='FICTIONAL' AND locality_id IS NOT NULL))
);
-- max five per user enforced in the insert command under a row lock on user_profile
CREATE INDEX address_user ON private.address (user_id);

CREATE TABLE core.identity_tombstone (
  fingerprint bytea PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('EMAIL','PHONE')),
  expires_at  timestamptz NOT NULL
);
