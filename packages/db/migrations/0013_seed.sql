-- Seed: configuration version 1, the MINT and SINK ledger accounts, system switches.
-- Money in configuration is carried as decimal strings (paise).

INSERT INTO core.config_version (id, values, effective_from, note)
OVERRIDING SYSTEM VALUE
VALUES (1, jsonb_build_object(
  'starter_grant_paise',     '100000000000',
  'creator_threshold_paise', '1000000000',
  'price_min_paise',         '10000',
  'price_max_paise',         '100000000000'
), '2026-01-01T00:00:00Z', 'initial configuration');
SELECT setval(pg_get_serial_sequence('core.config_version', 'id'), 1);

INSERT INTO ledger.ledger_account (id, type, user_id) VALUES
  ('00000000-0000-7000-8000-000000000001', 'MINT', NULL),
  ('00000000-0000-7000-8000-000000000002', 'SINK', NULL);

INSERT INTO core.system_switch (name, enabled, updated_at) VALUES
  ('purchases', true, now()),
  ('signup_grants', true, now()),
  ('publication', true, now()),
  ('npc', true, now()),
  ('payments_card', true, now()),
  ('payments_netbanking', true, now());
