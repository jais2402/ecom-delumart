-- Onboarding (LLD §7.1, PRD revision: "the starting grant, bank account and card are created only
-- after both email and phone are verified"). Every function here is actor-scoped (the user comes
-- from the sign-in session, core.actor_id()), SECURITY DEFINER, and executable by app_pay only.
--
--   core.onboarding_status()                       the actor's step flags
--   core.record_phone_verified(phone_fp, email_fp) step 1: the verified phone (creates the profile)
--   core.record_birthdate(birthdate_enc, is_adult) step 2: the encrypted birthdate, once
--   core.provision_account(...)                    step 3: now requires steps 1 and 2 (adult)
--
-- The database never sees a plain phone number, email address or birthdate: only HMAC
-- fingerprints (LLD §5.6) and the AES-256-GCM ciphertext made by the web deployment, which alone
-- holds the field-encryption key.

-- ---------------------------------------------------------------- recent sign-in
-- When the actor's sign-in session was created (auth.sessions.created_at), or NULL without a live
-- session. Like core.actor_id() (0001) it reads the transaction-local app.session_id, never
-- raises and never echoes the session id; it answers only for the session that core.actor_id()
-- accepts. Executable by no application role.
CREATE FUNCTION core.actor_session_created_at() RETURNS timestamptz
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  raw     text := current_setting('app.session_id', true);
  actor   uuid := core.actor_id();
  created timestamptz;
BEGIN
  IF actor IS NULL OR raw IS NULL
     OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  SELECT s.created_at INTO created FROM auth.sessions s WHERE s.id = raw::uuid AND s.user_id = actor;
  RETURN created;
END $$;

-- LLD §11.1 recent-auth: the actions that need a sign-in within the last
-- `recent_auth_seconds` (300) refuse with REAUTH_REQUIRED otherwise.
CREATE FUNCTION core.require_recent_sign_in() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  created timestamptz := core.actor_session_created_at();
BEGIN
  IF created IS NULL OR created < clock_timestamp() - make_interval(
       secs => core.config_int(core.current_config_id(), ARRAY['recent_auth_seconds'], 300)) THEN
    PERFORM core.fail('REAUTH_REQUIRED', 'sign in again to continue');
  END IF;
END $$;

-- ---------------------------------------------------------------- sign-in service's phone flag
-- The web server verifies the SMS code with the sign-in service and then calls
-- core.record_phone_verified: THE DATABASE TRUSTS THE CALLER (app_pay) THAT THE CODE WAS VERIFIED.
-- That trust is removed when the sign-in service records the confirmation itself: when
-- auth.users has a phone_confirmed_at column (Supabase Auth phone confirmation), the function
-- below is created to require it to be set for the actor, so a caller can no longer mark an
-- unconfirmed phone verified. Without the column (the local stand-in of 0001), it answers true.
-- Chosen once, when this migration runs; re-run the migration set after enabling the column.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'phone_confirmed_at') THEN
    CREATE FUNCTION core.auth_phone_confirmed(actor uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
      SELECT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = actor AND u.phone_confirmed_at IS NOT NULL)
    $f$;
  ELSE
    -- TRUSTED CALLER: no sign-in-service flag to check (see above)
    CREATE FUNCTION core.auth_phone_confirmed(actor uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
      SELECT actor IS NOT NULL
    $f$;
  END IF;
END $do$;

-- ---------------------------------------------------------------- status
CREATE FUNCTION core.onboarding_status_of(actor uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object(
    'hasProfile', u.id IS NOT NULL,
    'phoneVerified', COALESCE(u.phone_verified_at IS NOT NULL AND u.phone_fingerprint IS NOT NULL, false),
    'hasBirthdate', EXISTS (SELECT 1 FROM private.user_secret s WHERE s.user_id = actor),
    'isAdult', COALESCE(u.is_adult, false),
    'provisioned', COALESCE(u.provisioned_at IS NOT NULL, false),
    'pinSet', EXISTS (SELECT 1 FROM core.virtual_card vc
                       WHERE vc.user_id = actor AND vc.status IN ('ACTIVE', 'FROZEN') AND vc.pin_hash IS NOT NULL))
    FROM (SELECT actor AS id) a LEFT JOIN core.user_profile u ON u.id = a.id
$$;

CREATE FUNCTION core.onboarding_status()
RETURNS TABLE (has_profile boolean, phone_verified boolean, has_birthdate boolean, is_adult boolean,
               provisioned boolean, pin_set boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := core.actor_id();
  s     jsonb;
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  s := core.onboarding_status_of(actor);
  RETURN QUERY SELECT (s ->> 'hasProfile')::boolean, (s ->> 'phoneVerified')::boolean,
                      (s ->> 'hasBirthdate')::boolean, (s ->> 'isAdult')::boolean,
                      (s ->> 'provisioned')::boolean, (s ->> 'pinSet')::boolean;
END $$;

-- ---------------------------------------------------------------- step 1: verified phone
-- Records the actor's verified phone fingerprint, creating the actor's profile with the given
-- email fingerprint if it does not exist yet (an existing profile keeps its email fingerprint).
-- A phone or email fingerprint held by ANOTHER account is one uniform CONFLICT that does not say
-- which (US-49). Changing the phone after provisioning needs a recent sign-in (LLD §11.1).
-- See core.auth_phone_confirmed above for what the database trusts the caller with.
CREATE FUNCTION core.record_phone_verified(phone_fingerprint bytea, email_fingerprint bytea) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor uuid := core.actor_id();
  u     record;
  conflict_msg constant text := 'This phone number or email already belongs to another account.';
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  IF phone_fingerprint IS NULL OR octet_length(phone_fingerprint) <> 32
     OR email_fingerprint IS NULL OR octet_length(email_fingerprint) <> 32 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'fingerprints are 32-byte HMACs');
  END IF;
  IF NOT core.auth_phone_confirmed(actor) THEN
    PERFORM core.fail('PHONE_REQUIRED', 'confirm your phone number first');
  END IF;
  IF EXISTS (SELECT 1 FROM core.user_profile p
              WHERE p.id <> actor AND p.phone_fingerprint = record_phone_verified.phone_fingerprint) THEN
    PERFORM core.fail('CONFLICT', conflict_msg);
  END IF;
  INSERT INTO core.user_profile (id, email_fingerprint) VALUES (actor, email_fingerprint) ON CONFLICT DO NOTHING;
  SELECT p.phone_fingerprint, p.phone_verified_at, p.provisioned_at INTO u
    FROM core.user_profile p WHERE p.id = actor FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM core.fail('CONFLICT', conflict_msg);   -- the email fingerprint is another account's
  END IF;
  IF u.phone_fingerprint = record_phone_verified.phone_fingerprint AND u.phone_verified_at IS NOT NULL THEN
    RETURN core.onboarding_status_of(actor);       -- already recorded
  END IF;
  IF u.provisioned_at IS NOT NULL THEN
    PERFORM core.require_recent_sign_in();          -- changing the phone of a provisioned account
  END IF;
  BEGIN
    UPDATE core.user_profile p SET phone_fingerprint = record_phone_verified.phone_fingerprint,
                                   phone_verified_at = now()
     WHERE p.id = actor;
  EXCEPTION WHEN unique_violation THEN
    PERFORM core.fail('CONFLICT', conflict_msg);   -- taken concurrently
  END;
  RETURN core.onboarding_status_of(actor);
END $$;

-- ---------------------------------------------------------------- step 2: birthdate, once
-- Stores the AES-256-GCM ciphertext of the birthdate (made by the web deployment; THE DATABASE
-- NEVER SEES THE PLAIN BIRTHDATE) and the adult flag the web derived from it, exactly once:
-- afterwards neither can be changed except by the owner role (no application role holds INSERT
-- or UPDATE on private.user_secret, 0011). Repeating the same call is answered from the stored
-- row; a different value is CONFLICT. A minor is recorded too (so a second, different birthdate
-- cannot be tried) and then refused at provisioning (UNDERAGE): the returned status says
-- isAdult false and the TypeScript layer reports UNDERAGE after the record commits.
CREATE FUNCTION core.record_birthdate(birthdate_enc bytea, is_adult boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor  uuid := core.actor_id();
  stored record;
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  IF birthdate_enc IS NULL OR octet_length(birthdate_enc) NOT BETWEEN 16 AND 512 OR is_adult IS NULL THEN
    PERFORM core.fail('VALIDATION_FAILED', 'an encrypted birthdate and the adult flag are required');
  END IF;
  PERFORM 1 FROM core.user_profile p
   WHERE p.id = actor AND p.phone_verified_at IS NOT NULL AND p.phone_fingerprint IS NOT NULL
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM core.fail('PHONE_REQUIRED', 'verify your phone number first');
  END IF;
  SELECT s.birthdate_enc, p.is_adult INTO stored
    FROM private.user_secret s JOIN core.user_profile p ON p.id = s.user_id WHERE s.user_id = actor;
  IF FOUND THEN
    IF stored.birthdate_enc = record_birthdate.birthdate_enc AND stored.is_adult = record_birthdate.is_adult THEN
      RETURN core.onboarding_status_of(actor);
    END IF;
    PERFORM core.fail('CONFLICT', 'your birthdate is already recorded');
  END IF;
  INSERT INTO private.user_secret (user_id, birthdate_enc) VALUES (actor, birthdate_enc);
  UPDATE core.user_profile p SET is_adult = record_birthdate.is_adult WHERE p.id = actor;
  RETURN core.onboarding_status_of(actor);
END $$;

-- ---------------------------------------------------------------- step 3: provisioning
-- The ONLY way an account is provisioned, for the signed-in actor (LLD §7.1). The profile is not
-- created here: it must exist with a verified phone (PHONE_REQUIRED), a recorded birthdate
-- (VALIDATION_FAILED) and the adult flag (UNDERAGE) before anything is granted. Card numbers and
-- collisions as described in 0022. The tombstone rule is applied, in this same call, to the
-- fingerprints stored on the locked profile row and to the ones presented. Idempotent under
-- concurrency: concurrent calls serialise on the profile row and return the records the first one
-- created; the STARTER grant is never repeated (US-01, US-14).
CREATE FUNCTION core.provision_account(email_fingerprint bytea, phone_fingerprint bytea, card_numbers text[],
                                                  alias text, upi_style_id text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor      uuid := core.actor_id();
  prof       record;
  tombstoned boolean;
  existing   record;
  acct       uuid := core.uuid_v7();
  bank       uuid := core.uuid_v7();
  card       uuid := core.uuid_v7();
  chosen     text;
  candidate  text;
  journal    uuid;
  grant_id   uuid;
  cfg        int;
  amount     bigint := 0;
  conflict_msg constant text := 'This phone number or email already belongs to another account.';
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  PERFORM ledger.require_read_committed();
  IF email_fingerprint IS NULL OR octet_length(email_fingerprint) <> 32
     OR (phone_fingerprint IS NOT NULL AND octet_length(phone_fingerprint) <> 32) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'fingerprints are 32-byte HMACs');
  END IF;
  IF card_numbers IS NULL OR cardinality(card_numbers) NOT BETWEEN 1 AND 5
     OR array_ndims(card_numbers) <> 1
     OR EXISTS (SELECT 1 FROM unnest(card_numbers) n WHERE NOT core.is_delulu_card_number(n)) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'give 1-5 candidate DeluluMart card numbers');
  END IF;
  IF alias IS NULL OR char_length(alias) NOT BETWEEN 3 AND 64
     OR upi_style_id IS NULL OR char_length(upi_style_id) NOT BETWEEN 3 AND 64 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'alias and DeluluPay id are 3-64 characters');
  END IF;

  -- a presented fingerprint held by another account: one answer, whichever it is
  IF EXISTS (SELECT 1 FROM core.user_profile u
              WHERE u.id <> actor
                AND (u.email_fingerprint = provision_account.email_fingerprint
                  OR u.phone_fingerprint = provision_account.phone_fingerprint)) THEN
    PERFORM core.fail('CONFLICT', conflict_msg);
  END IF;
  -- the tombstone rule applies to the fingerprints stored on the profile AND to the ones
  -- presented now: a profile that somehow carries other fingerprints earns no grant for an
  -- identity that is tombstoned
  SELECT u.phone_verified_at IS NOT NULL AND u.phone_fingerprint IS NOT NULL AS phone_ok, u.is_adult,
         EXISTS (SELECT 1 FROM private.user_secret s WHERE s.user_id = u.id) AS has_birthdate,
         core.identity_is_tombstoned(u.email_fingerprint, u.phone_fingerprint)
         OR core.identity_is_tombstoned(provision_account.email_fingerprint, provision_account.phone_fingerprint)
           AS tombstoned
    INTO prof
    FROM core.user_profile u WHERE u.id = actor FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM core.fail('PHONE_REQUIRED', 'verify your phone number first');
  END IF;
  tombstoned := prof.tombstoned;

  SELECT la.id AS ledger_account_id, ba.id AS bank_account_id, vc.id AS card_id, vc.card_number,
         w.available_paise, gr.journal_id, gr.id AS grant_id
    INTO existing
    FROM ledger.ledger_account la
    JOIN core.bank_account ba ON ba.ledger_account_id = la.id
    JOIN ledger.wallet w ON w.account_id = la.id
    JOIN core.virtual_card vc ON vc.bank_account_id = ba.id AND vc.status IN ('ACTIVE', 'FROZEN')
    LEFT JOIN ledger.grant_record gr ON gr.user_id = la.user_id AND gr.type = 'STARTER'
   WHERE la.user_id = actor;
  IF FOUND THEN
    RETURN jsonb_build_object('created', false, 'userId', actor, 'ledgerAccountId', existing.ledger_account_id,
      'bankAccountId', existing.bank_account_id, 'cardId', existing.card_id, 'cardNumber', existing.card_number,
      'walletPaise', existing.available_paise::text, 'starterJournalId', existing.journal_id,
      'grantRecordId', existing.grant_id);
  END IF;
  IF NOT prof.phone_ok THEN
    PERFORM core.fail('PHONE_REQUIRED', 'verify your phone number first');
  END IF;
  IF NOT prof.has_birthdate THEN
    PERFORM core.fail('VALIDATION_FAILED', 'record your birthdate first');
  END IF;
  IF NOT prof.is_adult THEN
    PERFORM core.fail('UNDERAGE', 'DeluluMart accounts are for adults');
  END IF;

  SET CONSTRAINTS ALL DEFERRED;   -- whatever mode the caller left: the checks run below, synchronously
  INSERT INTO ledger.ledger_account (id, type, user_id) VALUES (acct, 'USER', actor);
  BEGIN
    INSERT INTO core.bank_account (id, user_id, ledger_account_id, alias, upi_style_id)
    VALUES (bank, actor, acct, alias, upi_style_id);
  EXCEPTION WHEN unique_violation THEN
    PERFORM core.fail('BUSY', 'could not open the account just now; try again');
  END;
  IF NOT tombstoned THEN
    cfg := core.current_config_id();
    IF cfg IS NULL THEN
      PERFORM core.fail('MAINTENANCE', 'no effective configuration version');
    END IF;
    amount := ledger.starter_grant_paise();   -- a product rule, never configuration
    journal := core.uuid_v7();
    grant_id := core.uuid_v7();
    INSERT INTO ledger.journal (id, event_type, config_version, funding_bank_account_id)
    VALUES (journal, 'STARTER_GRANT', cfg, bank);
    INSERT INTO ledger.posting (journal_id, account_id, amount, memo) VALUES
      (journal, '00000000-0000-7000-8000-000000000001', -amount, 'Starting grant'),
      (journal, acct, amount, 'Starting grant');
    INSERT INTO ledger.grant_record (id, user_id, journal_id, type, amount, utc_day)
    VALUES (grant_id, actor, journal, 'STARTER', amount, (now() AT TIME ZONE 'UTC')::date);
  END IF;
  INSERT INTO ledger.wallet (account_id, available_paise) VALUES (acct, amount);
  -- the first candidate nobody holds; a concurrent sign-up taking the same number moves us on
  FOREACH candidate IN ARRAY card_numbers LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM core.virtual_card vc WHERE vc.card_number = candidate);
    BEGIN
      INSERT INTO core.virtual_card (id, user_id, bank_account_id, sequence, card_number, status)
      VALUES (card, actor, bank, 1, candidate, 'ACTIVE');
      chosen := candidate;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      NULL;
    END;
  END LOOP;
  IF chosen IS NULL THEN
    PERFORM core.fail('BUSY', 'could not open the account just now; try again');
  END IF;
  UPDATE core.user_profile SET provisioned_at = now() WHERE id = actor;

  SET CONSTRAINTS ALL IMMEDIATE;   -- every structural check, now (R9 seals the grant journal)
  SET CONSTRAINTS ALL DEFERRED;    -- back to the declared mode for the rest of the caller's transaction
  RETURN jsonb_build_object('created', true, 'userId', actor, 'ledgerAccountId', acct, 'bankAccountId', bank,
    'cardId', card, 'cardNumber', chosen, 'walletPaise', amount::text, 'starterJournalId', journal,
    'grantRecordId', grant_id);
END $$;

REVOKE ALL ON FUNCTION core.actor_session_created_at(), core.require_recent_sign_in(),
  core.auth_phone_confirmed(uuid), core.onboarding_status_of(uuid), core.onboarding_status(),
  core.record_phone_verified(bytea, bytea), core.record_birthdate(bytea, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.provision_account(bytea, bytea, text[], text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.onboarding_status(), core.record_phone_verified(bytea, bytea),
  core.record_birthdate(bytea, boolean), core.provision_account(bytea, bytea, text[], text, text) TO app_pay;
