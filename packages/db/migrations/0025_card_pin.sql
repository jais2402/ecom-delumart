-- Delulu card PIN inside the database (LLD §5.5, US-48) and card freezing.
--
-- THE DATABASE NEVER SEES A PIN. The web server sends only pin_mac = HMAC-SHA-256(PIN_PEPPER, pin)
-- (32 bytes; the pepper lives in the web deployment's secret store) after checking the PIN rules
-- (six digits, not weak, not the birthdate: packages/core/src/pin). The database stores
-- crypt(hex(pin_mac), gen_salt('bf', 10)) (pgcrypto bcrypt) in core.virtual_card.pin_hash, which
-- no application role can read (column privileges below), and compares with crypt() under the
-- card's row lock.
--
--   core.set_card_pin(card, pin_mac, current_pin_mac)  first set; a change needs the current PIN
--   core.reset_card_pin(card, pin_mac)                 needs a sign-in within five minutes
--   core.verify_card_pin(attempt, pin_mac)             the ONLY way a CARD attempt is authenticated
--   core.set_card_frozen(card, frozen)                 the owner freezes or unfreezes
--
-- Limits (configuration, LLD §11.2): `pin_tries_per_attempt` (3) wrong PINs fail the attempt
-- (CHALLENGE_LOCKED, nothing debited); `pin_consecutive_failures_max` (5) consecutive wrong PINs
-- on a card, across attempts and PIN changes, lock it for `pin_lock_seconds` (900). The card
-- counter counts consecutive failures: a correct PIN (or a reset) sets it back to zero, so after
-- a lock expires one more wrong PIN locks the card again. Counters move under the card's row
-- lock (after the checkout session's and the attempt's, LLD §4), so parallel guesses cannot pass
-- the limits. A wrong PIN is RETURNED as a result row, not raised, so that the counters commit;
-- the TypeScript layer commits and then reports the DomainError.

-- ---------------------------------------------------------------- pgcrypto, schema-qualified
-- pgcrypto lives wherever the platform installed it (public locally, `extensions` on Supabase):
-- the two wrappers are created with that schema named explicitly (as in 0020).
DO $do$
DECLARE
  sch text;
BEGIN
  SELECT n.nspname INTO sch FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'pgcrypto';
  EXECUTE format($f$
    CREATE FUNCTION core.pin_hash(pin_mac bytea) RETURNS text
    LANGUAGE sql VOLATILE SET search_path = pg_catalog, pg_temp AS $b$
      SELECT %1$I.crypt(encode(pin_mac, 'hex'), %1$I.gen_salt('bf', 10))
    $b$
  $f$, sch);
  EXECUTE format($f$
    CREATE FUNCTION core.pin_matches(pin_mac bytea, stored text) RETURNS boolean
    LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $b$
      SELECT stored IS NOT NULL AND %1$I.crypt(encode(pin_mac, 'hex'), stored) = stored
    $b$
  $f$, sch);
END $do$;

-- ---------------------------------------------------------------- nobody reads the hash
-- app_web, app_pay and app_jobs keep SELECT on every card column except the PIN hash and salt and
-- the card number (shown in full only through core.reveal_card_number, 0026, after a recent
-- sign-in). PIN counters move only inside the functions below: app_jobs no longer updates them.
REVOKE SELECT ON core.virtual_card FROM app_web, app_pay, app_jobs;
GRANT SELECT (id, user_id, bank_account_id, sequence, status, merchant_scope, pin_set_at, failed_pin_count,
              pin_locked_until) ON core.virtual_card TO app_web, app_pay, app_jobs;
REVOKE UPDATE ON core.virtual_card FROM app_jobs;
GRANT UPDATE (status) ON core.virtual_card TO app_jobs;

-- ---------------------------------------------------------------- helpers
CREATE FUNCTION core.require_pin_mac(mac bytea) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF mac IS NULL OR octet_length(mac) <> 32 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'a PIN is sent as its 32-byte HMAC');
  END IF;
END $$;

-- One wrong PIN on a locked (FOR NO KEY UPDATE) card: counts it and locks the card at the limit.
-- Returns the card's consecutive failures afterwards and whether it is now locked.
CREATE FUNCTION core.count_pin_failure(p_card_id uuid, OUT failures int, OUT locked boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cfg int := core.current_config_id();
BEGIN
  UPDATE core.virtual_card vc
     SET failed_pin_count = vc.failed_pin_count + 1,
         pin_locked_until = CASE
           WHEN vc.failed_pin_count + 1 >= core.config_int(cfg, ARRAY['pin_consecutive_failures_max'], 5)
           THEN clock_timestamp() + make_interval(secs => core.config_int(cfg, ARRAY['pin_lock_seconds'], 900))
           ELSE vc.pin_locked_until END
   WHERE vc.id = p_card_id
  RETURNING vc.failed_pin_count, vc.pin_locked_until > clock_timestamp() INTO failures, locked;
  locked := COALESCE(locked, false);
END $$;

-- ---------------------------------------------------------------- set / change
-- First set needs no current PIN. A change needs the correct current_pin_mac; a wrong one counts
-- as a wrong PIN on the card (it is a guess like any other) and is returned, not raised.
-- Returns (status, remaining_tries): PIN_SET | PIN_INCORRECT | PIN_LOCKED.
CREATE FUNCTION core.set_card_pin(card_id uuid, pin_mac bytea, current_pin_mac bytea DEFAULT NULL)
RETURNS TABLE (status text, remaining_tries int)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor uuid := core.actor_id();
  c     record;
  f     record;
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  PERFORM ledger.require_read_committed();
  PERFORM core.require_pin_mac(pin_mac);
  SELECT vc.status AS card_status, vc.pin_hash, vc.pin_locked_until > clock_timestamp() AS locked INTO c
    FROM core.virtual_card vc WHERE vc.id = set_card_pin.card_id AND vc.user_id = actor FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM core.fail('CARD_NOT_OWNED', 'card not found for this user');
  END IF;
  IF c.card_status = 'REPLACED' THEN
    PERFORM core.fail('CARD_REPLACED', 'card has been replaced');
  END IF;
  IF c.pin_hash IS NOT NULL THEN
    IF c.locked THEN
      PERFORM core.fail('PIN_LOCKED', 'too many wrong PINs; try again later');
    END IF;
    IF current_pin_mac IS NULL THEN
      PERFORM core.fail('VALIDATION_FAILED', 'changing the PIN needs the current PIN');
    END IF;
    PERFORM core.require_pin_mac(current_pin_mac);
    IF NOT core.pin_matches(current_pin_mac, c.pin_hash) THEN
      SELECT * INTO f FROM core.count_pin_failure(set_card_pin.card_id);
      IF f.locked THEN
        RETURN QUERY SELECT 'PIN_LOCKED'::text, 0;
      ELSE
        RETURN QUERY SELECT 'PIN_INCORRECT'::text,
          greatest(core.config_int(core.current_config_id(), ARRAY['pin_consecutive_failures_max'], 5)::int - f.failures, 0);
      END IF;
      RETURN;
    END IF;
  END IF;
  UPDATE core.virtual_card vc
     SET pin_hash = core.pin_hash(set_card_pin.pin_mac), pin_salt = NULL, pin_set_at = now(),
         failed_pin_count = 0, pin_locked_until = NULL
   WHERE vc.id = set_card_pin.card_id;
  RETURN QUERY SELECT 'PIN_SET'::text, NULL::int;
END $$;

-- ---------------------------------------------------------------- reset (forgotten PIN)
-- Allowed only with a sign-in session created within the last `recent_auth_seconds` (300):
-- signing in again is the proof. Clears the counters and any lock.
CREATE FUNCTION core.reset_card_pin(card_id uuid, pin_mac bytea) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor uuid := core.actor_id();
  st    text;
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  PERFORM ledger.require_read_committed();
  PERFORM core.require_pin_mac(pin_mac);
  PERFORM core.require_recent_sign_in();
  SELECT vc.status INTO st FROM core.virtual_card vc
   WHERE vc.id = reset_card_pin.card_id AND vc.user_id = actor FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM core.fail('CARD_NOT_OWNED', 'card not found for this user');
  END IF;
  IF st = 'REPLACED' THEN
    PERFORM core.fail('CARD_REPLACED', 'card has been replaced');
  END IF;
  UPDATE core.virtual_card vc
     SET pin_hash = core.pin_hash(reset_card_pin.pin_mac), pin_salt = NULL, pin_set_at = now(),
         failed_pin_count = 0, pin_locked_until = NULL
   WHERE vc.id = reset_card_pin.card_id;
END $$;

-- ---------------------------------------------------------------- verify (the card payment's PIN step)
-- The attempt must be the actor's own PENDING, not yet authenticated CARD attempt on an OPEN,
-- unexpired checkout session. Locks: checkout session (LLD §4 #1), the attempt, the card (#8).
-- Raises PIN_LOCKED (card locked), PIN_NOT_SET, CARD_FROZEN, CARD_REPLACED before any guess.
-- Returns (status, remaining_tries):
--   AUTHENTICATED     the attempt is authenticated (database clock), counters reset
--   PIN_INCORRECT     wrong; remaining_tries = what is left before the attempt fails or the card locks
--   CHALLENGE_LOCKED  the third wrong PIN on this attempt: the attempt is FAILED (CHALLENGE_LOCKED)
--   PIN_LOCKED        the wrong PIN locked the card for `pin_lock_seconds`
CREATE FUNCTION core.verify_card_pin(attempt_id uuid, pin_mac bytea)
RETURNS TABLE (status text, remaining_tries int)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor  uuid := core.actor_id();
  cfg    int := core.current_config_id();
  tries  int := core.config_int(cfg, ARRAY['pin_tries_per_attempt'], 3);
  maxf   int := core.config_int(cfg, ARRAY['pin_consecutive_failures_max'], 5);
  a      record;
  s      record;
  c      record;
  used   int;
  f      record;
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  PERFORM ledger.require_read_committed();
  PERFORM core.require_pin_mac(pin_mac);
  SELECT pa.session_id, pa.method INTO a FROM core.payment_attempt pa
   WHERE pa.id = verify_card_pin.attempt_id AND pa.user_id = actor;
  IF NOT FOUND THEN
    PERFORM core.fail('NOT_FOUND', 'payment attempt not found');
  END IF;
  IF a.method <> 'CARD' THEN
    PERFORM core.fail('CONFLICT', 'only a card payment has a PIN step');
  END IF;
  -- #1 the checkout session
  SELECT cs.state, cs.expires_at, cs.expires_at <= clock_timestamp() AS expired INTO s
    FROM core.checkout_session cs WHERE cs.id = a.session_id AND cs.user_id = actor FOR NO KEY UPDATE;
  IF NOT FOUND OR s.state <> 'OPEN' THEN
    PERFORM core.fail('CONFLICT', 'checkout session is no longer open');
  END IF;
  IF s.expired THEN
    PERFORM core.fail('CHECKOUT_EXPIRED', 'checkout session has expired');
  END IF;
  -- the attempt, re-read under its lock
  SELECT pa.state, pa.card_id, pa.authenticated_at INTO a FROM core.payment_attempt pa
   WHERE pa.id = verify_card_pin.attempt_id FOR NO KEY UPDATE;
  IF a.state <> 'PENDING' THEN
    PERFORM core.fail('CONFLICT', 'payment attempt is no longer pending');
  END IF;
  IF a.authenticated_at IS NOT NULL THEN
    PERFORM core.fail('CONFLICT', 'payment attempt is already authenticated');
  END IF;
  -- #8 the card
  SELECT vc.status AS card_status, vc.pin_hash, vc.pin_locked_until > clock_timestamp() AS locked INTO c
    FROM core.virtual_card vc WHERE vc.id = a.card_id AND vc.user_id = actor FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM core.fail('CARD_NOT_OWNED', 'card not found for this user');
  ELSIF c.card_status = 'FROZEN' THEN
    PERFORM core.fail('CARD_FROZEN', 'card is frozen');
  ELSIF c.card_status <> 'ACTIVE' THEN
    PERFORM core.fail('CARD_REPLACED', 'card has been replaced');
  END IF;
  IF c.locked THEN
    PERFORM core.fail('PIN_LOCKED', 'too many wrong PINs; try again later');
  END IF;
  IF c.pin_hash IS NULL THEN
    PERFORM core.fail('PIN_NOT_SET', 'set a Delulu PIN for this card first');
  END IF;
  INSERT INTO core.payment_challenge (attempt_id, kind, expires_at)
  VALUES (verify_card_pin.attempt_id, 'PIN', s.expires_at) ON CONFLICT DO NOTHING;
  SELECT pc.attempts_used INTO used FROM core.payment_challenge pc
   WHERE pc.attempt_id = verify_card_pin.attempt_id FOR UPDATE;

  IF core.pin_matches(pin_mac, c.pin_hash) THEN
    UPDATE core.virtual_card vc SET failed_pin_count = 0, pin_locked_until = NULL WHERE vc.id = a.card_id;
    UPDATE core.payment_challenge pc SET passed_at = now() WHERE pc.attempt_id = verify_card_pin.attempt_id;
    UPDATE core.payment_attempt pa SET authenticated_at = now() WHERE pa.id = verify_card_pin.attempt_id;
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
    RETURN QUERY SELECT 'AUTHENTICATED'::text, NULL::int;
    RETURN;
  END IF;

  SELECT * INTO f FROM core.count_pin_failure(a.card_id);
  used := used + 1;
  UPDATE core.payment_challenge pc SET attempts_used = used WHERE pc.attempt_id = verify_card_pin.attempt_id;
  IF used >= tries THEN
    UPDATE core.payment_attempt pa SET state = 'FAILED', failure_code = 'CHALLENGE_LOCKED'
     WHERE pa.id = verify_card_pin.attempt_id;
  END IF;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  IF f.locked THEN
    RETURN QUERY SELECT 'PIN_LOCKED'::text, 0;
  ELSIF used >= tries THEN
    RETURN QUERY SELECT 'CHALLENGE_LOCKED'::text, 0;
  ELSE
    RETURN QUERY SELECT 'PIN_INCORRECT'::text, least(tries - used, maxf - f.failures);
  END IF;
END $$;

-- ---------------------------------------------------------------- freeze / unfreeze
-- The owner moves the card ACTIVE <-> FROZEN (a replaced card stays replaced). The card row is
-- locked as pay locks it (LLD §4 #8), so a freeze racing a payment resolves to one outcome
-- (US-15). Returns the card's status.
CREATE FUNCTION core.set_card_frozen(card_id uuid, frozen boolean) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor uuid := core.actor_id();
  st    text;
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  PERFORM ledger.require_read_committed();
  IF frozen IS NULL THEN
    PERFORM core.fail('VALIDATION_FAILED', 'frozen is true or false');
  END IF;
  SELECT vc.status INTO st FROM core.virtual_card vc
   WHERE vc.id = set_card_frozen.card_id AND vc.user_id = actor FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM core.fail('CARD_NOT_OWNED', 'card not found for this user');
  END IF;
  IF st = 'REPLACED' THEN
    PERFORM core.fail('CARD_REPLACED', 'card has been replaced');
  END IF;
  UPDATE core.virtual_card vc SET status = CASE WHEN frozen THEN 'FROZEN' ELSE 'ACTIVE' END
   WHERE vc.id = set_card_frozen.card_id
  RETURNING vc.status INTO st;
  RETURN st;
END $$;

REVOKE ALL ON FUNCTION core.pin_hash(bytea), core.pin_matches(bytea, text), core.require_pin_mac(bytea),
  core.count_pin_failure(uuid), core.set_card_pin(uuid, bytea, bytea), core.reset_card_pin(uuid, bytea),
  core.verify_card_pin(uuid, bytea), core.set_card_frozen(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.set_card_pin(uuid, bytea, bytea), core.reset_card_pin(uuid, bytea),
  core.verify_card_pin(uuid, bytea), core.set_card_frozen(uuid, boolean) TO app_pay;
