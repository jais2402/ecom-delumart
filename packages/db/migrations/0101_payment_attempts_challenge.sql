-- DeluluPay attempts, the authentication step and the in-app bank inbox (PRD R4.2 to R4.6, R10, §11.2;
-- US-34, US-35, US-36).
--
--  * Methods. A payment attempt may now be DELULUPAY_ID (an approval request in the bank inbox) or
--    NET_BANKING (a simulated bank page, then a six-digit code from the inbox), besides CARD (PIN, 0025)
--    and BALANCE. They apply to PRODUCT_PURCHASE sessions; a company registration still takes BALANCE or
--    CARD only (its commit function, 0034, is unchanged; decisions.md #17). Every attempt passes
--    core.payment_method_gate (0100) when it is created and again when it pays (0102).
--  * The generic challenge. core.issue_payment_challenge makes a server-generated code (never taken from
--    the client) or an approval request for the session's pending attempt; the code is stored only as a
--    hash (core.payment_challenge.code_hash, which no application role can read), is valid
--    `challenge_ttl_seconds` (180), is single use, and the attempt gets `challenge_tries` (3) wrong tries in
--    all (a resend does not reset them): the third fails the attempt with CHALLENGE_LOCKED. A new code may be
--    asked for `challenge_resend_seconds` (30) after the last, and at most `challenge_codes_per_hour` (5)
--    codes or requests are issued per account per hour (RATE_LIMITED; counted per account, so no stranger
--    can use up anyone else's). core.verify_payment_challenge checks a code or the approve / decline
--    decision; both are idempotent in effect (a passed challenge cannot be used again).
--  * The bank inbox. The code is shown only in core.bank_inbox_message, read by core.my_bank_inbox (0103) for
--    the payer alone, and is scrubbed to NULL as soon as the challenge ends (passed, expired, locked,
--    cancelled, superseded). It is never in an event, a log, the outbox or any other response. R4.4: the
--    code is part of the experience, not a second security factor; the signed-in session stays the real
--    authority.
--  * Failure model. A failed attempt keeps a stored code: INSUFFICIENT_FUNDS, CARD_FROZEN, CARD_REPLACED,
--    CHALLENGE_FAILED, CHALLENGE_EXPIRED, CHALLENGE_LOCKED, CANCELLED (cancelled by you, or a declined
--    approval), METHOD_UNAVAILABLE, METHOD_LIMIT_EXCEEDED, BANK_UNAVAILABLE, CHECKOUT_EXPIRED (session
--    expired) and the pay step's own refusals. The displayed Created -> Authenticating -> Authorised ->
--    Captured status is derived from the stored state (core.payment_display_status, 0103).
--  * Test scenarios (R4.6). An attempt may carry a scenario that forces an outcome (INSUFFICIENT_FUNDS,
--    BANK_UNAVAILABLE, SLOW_BANK, CODE_LOCKOUT, CODE_EXPIRED), chosen by a reserved test DeluluPay ID
--    (testpay.<name>@delulu, which no player's ID can be: handles are [a-z0-9-]) or an explicit scenario. It
--    is allowed only when the owner switched deployment_setting 'payments.test_scenarios' on (staging,
--    local development) or the actor is a staff test account (is_test_account); otherwise it is refused
--    with VALIDATION_FAILED and nothing is created. Scenarios act at the authentication step only: they
--    never touch pricing, the ledger or the pay transaction.
--  * Locks (LLD §4): #1 the checkout session (FOR NO KEY UPDATE), then the attempt and its challenge row.
--    No card, wallet or other money lock is taken here.

-- ---------------------------------------------------------------- scenarios: the owner's switch
ALTER TABLE core.deployment_setting DROP CONSTRAINT deployment_setting_key_check;
ALTER TABLE core.deployment_setting DROP CONSTRAINT deployment_setting_value;
ALTER TABLE core.deployment_setting ADD CONSTRAINT deployment_setting_key_check
  CHECK (key IN ('identity.phone_verification', 'auth.session_max_age_seconds', 'payments.test_scenarios'));
ALTER TABLE core.deployment_setting ADD CONSTRAINT deployment_setting_value CHECK (
  (key = 'identity.phone_verification' AND value IN ('sms', 'unverified'))
  OR (key = 'auth.session_max_age_seconds' AND value ~ '^[0-9]{3,7}$' AND value::int BETWEEN 300 AND 7776000)
  OR (key = 'payments.test_scenarios' AND value IN ('on', 'off')));
-- production default: off. The owner (or `pnpm dev:setup` locally) switches it on for staging.
INSERT INTO core.deployment_setting (key, value) VALUES ('payments.test_scenarios', 'off');

CREATE FUNCTION core.payment_scenarios_allowed(p_actor uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE((SELECT s.value = 'on' FROM core.deployment_setting s WHERE s.key = 'payments.test_scenarios'), false)
      OR COALESCE((SELECT up.is_test_account FROM core.user_profile up WHERE up.id = p_actor), false)
$$;

-- the reserved test IDs and the scenario each forces (packages/core/src/pay TEST_DELULUPAY_IDS)
CREATE FUNCTION core.payment_scenario_of_test_id(p_id text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE p_id WHEN 'testpay.insufficient@delulu' THEN 'INSUFFICIENT_FUNDS'
                   WHEN 'testpay.bankdown@delulu' THEN 'BANK_UNAVAILABLE'
                   WHEN 'testpay.slow@delulu' THEN 'SLOW_BANK'
                   WHEN 'testpay.lockout@delulu' THEN 'CODE_LOCKOUT'
                   WHEN 'testpay.expired@delulu' THEN 'CODE_EXPIRED' END
$$;

CREATE FUNCTION core.payment_scenario_names() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['INSUFFICIENT_FUNDS', 'BANK_UNAVAILABLE', 'SLOW_BANK', 'CODE_LOCKOUT', 'CODE_EXPIRED']
$$;

-- No player's DeluluPay ID can be a reserved test ID (belt and braces: handles already exclude the dot).
ALTER TABLE core.bank_account ADD CONSTRAINT bank_account_no_test_id CHECK (upi_style_id !~ '^testpay\.');

-- ---------------------------------------------------------------- attempts and challenges
ALTER TABLE core.payment_attempt
  ADD COLUMN scenario text CHECK (scenario IS NULL OR scenario = ANY (core.payment_scenario_names()));

ALTER TABLE core.payment_challenge
  ADD COLUMN issued_at   timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN available_at timestamptz,
  ADD COLUMN issue_count int NOT NULL DEFAULT 1 CHECK (issue_count >= 1),
  ADD CONSTRAINT payment_challenge_hash_coherent CHECK ((kind = 'CODE') = (code_hash IS NOT NULL));

-- No application role reads the code's hash (a six-digit code's hash is the code).
REVOKE SELECT ON core.payment_challenge FROM app_web, app_pay, app_jobs;
GRANT SELECT (attempt_id, kind, expires_at, attempts_used, passed_at, issued_at, available_at, issue_count)
  ON core.payment_challenge TO app_web, app_pay;

-- The bank inbox: what Delulu Bank "sends" the payer, inside the app only.
CREATE TABLE core.bank_inbox_message (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL,
  attempt_id   uuid NOT NULL REFERENCES core.payment_attempt (id),
  kind         text NOT NULL CHECK (kind IN ('CODE', 'APPROVAL')),
  code         text CHECK (code ~ '^[0-9]{6}$'),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at   timestamptz NOT NULL,
  available_at timestamptz,
  cleared_at   timestamptz,
  CONSTRAINT bank_inbox_code_coherent CHECK (
    (kind = 'APPROVAL' AND code IS NULL) OR (kind = 'CODE' AND (code IS NULL) = (cleared_at IS NOT NULL)))
);
CREATE INDEX bank_inbox_user_created ON core.bank_inbox_message (user_id, created_at DESC);
CREATE INDEX bank_inbox_attempt ON core.bank_inbox_message (attempt_id);
ALTER TABLE core.bank_inbox_message ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON core.bank_inbox_message USING (false) WITH CHECK (false);
REVOKE ALL ON core.bank_inbox_message FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;

-- ---------------------------------------------------------------- the attempt guard (0016), extended
-- DELULUPAY_ID and NET_BANKING attempts are created unauthenticated and authenticated once, by their
-- challenge; the scenario never changes.
CREATE OR REPLACE FUNCTION core.guard_payment_attempt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM ledger.require_read_committed();
  IF TG_OP = 'INSERT' THEN
    IF NEW.method IN ('CARD', 'DELULUPAY_ID', 'NET_BANKING') AND NEW.authenticated_at IS NOT NULL THEN
      RAISE EXCEPTION 'a % attempt is created unauthenticated; authentication is a separate step', NEW.method
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.method = 'CARD') <> (NEW.card_id IS NOT NULL) THEN
      RAISE EXCEPTION 'a card is given for CARD attempts and only for them' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.card_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM core.virtual_card c WHERE c.id = NEW.card_id AND c.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'the card does not belong to the paying user' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM core.checkout_session s WHERE s.id = NEW.session_id AND s.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'the checkout session does not belong to the paying user' USING ERRCODE = 'check_violation';
    END IF;
    -- balance payments are authenticated by the signed-in session itself, at creation
    NEW.authenticated_at := CASE WHEN NEW.method = 'BALANCE' THEN now() END;
    RETURN NEW;
  END IF;

  IF (NEW.session_id, NEW.user_id, NEW.method, NEW.card_id, NEW.reference, NEW.created_at, NEW.scenario)
     IS DISTINCT FROM (OLD.session_id, OLD.user_id, OLD.method, OLD.card_id, OLD.reference, OLD.created_at, OLD.scenario) THEN
    RAISE EXCEPTION 'payment attempt % is immutable except for its state and authentication', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state <> 'PENDING' AND (NEW.state, NEW.authenticated_at, NEW.failure_code)
                                IS DISTINCT FROM (OLD.state, OLD.authenticated_at, OLD.failure_code) THEN
    RAISE EXCEPTION 'payment attempt % is % and final', OLD.id, OLD.state USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state <> OLD.state AND NEW.state NOT IN ('SUCCEEDED', 'FAILED') THEN
    RAISE EXCEPTION 'payment attempt % may move only PENDING -> SUCCEEDED or FAILED', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.authenticated_at IS DISTINCT FROM OLD.authenticated_at THEN
    IF OLD.authenticated_at IS NOT NULL OR NEW.authenticated_at IS NULL
       OR OLD.method NOT IN ('CARD', 'DELULUPAY_ID', 'NET_BANKING') THEN
      RAISE EXCEPTION 'payment attempt %: only a pending CARD, DELULUPAY_ID or NET_BANKING attempt is authenticated, once', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.authenticated_at := now();   -- recorded by the database clock, not the caller
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- helpers
-- Ends an attempt: FAILED with a stored code, and the inbox codes of the attempt scrubbed.
CREATE FUNCTION core.payment_attempt_fail(p_attempt uuid, p_code text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE core.payment_attempt pa SET state = 'FAILED', failure_code = p_code
   WHERE pa.id = p_attempt AND pa.state = 'PENDING';
  UPDATE core.bank_inbox_message m SET code = NULL, cleared_at = clock_timestamp()
   WHERE m.attempt_id = p_attempt AND m.cleared_at IS NULL;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
END $$;

-- A six-digit code from the database's random source (uuid v4 bytes are random; 40 bits mod 10^6).
CREATE FUNCTION core.payment_new_code() RETURNS text
LANGUAGE sql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
  SELECT lpad((((get_byte(b, 0)::bigint << 32) | (get_byte(b, 1)::bigint << 24) | (get_byte(b, 2)::bigint << 16)
               | (get_byte(b, 3)::bigint << 8) | get_byte(b, 4)::bigint) % 1000000)::text, 6, '0')
    FROM (SELECT uuid_send(gen_random_uuid()) AS b) x
$$;

CREATE FUNCTION core.payment_code_hash(p_attempt uuid, p_code text) RETURNS bytea
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT sha256(convert_to(p_attempt::text || ':' || p_code, 'UTF8'))
$$;

-- ---------------------------------------------------------------- start an attempt
-- core.create_payment_attempt (0018) with the two new methods, the method gate, DeluluPay ID and the
-- scenario. The 3-argument function stays and calls this one.
CREATE FUNCTION core.start_payment_attempt(p_session_id uuid, p_method text, p_card_id uuid,
                                           p_delulupay_id text, p_scenario text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor    uuid := core.actor_id();
  s        record;
  c        record;
  aid      uuid := core.uuid_v7();
  ref      text := 'DLP-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 20));
  v_id     text;
  v_own    text;
  v_scenario text := p_scenario;
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  PERFORM ledger.require_read_committed();
  IF p_method IS NULL OR p_method <> ALL (core.payment_method_names()) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'unsupported payment method');
  END IF;
  -- at most `payment_attempts_per_minute` (10) attempts per actor in any rolling minute
  PERFORM core.lock_actor('core.payment_attempt', actor);
  IF (SELECT count(*) FROM core.payment_attempt pa
       WHERE pa.user_id = actor AND pa.created_at > clock_timestamp() - interval '1 minute')
     >= core.config_int(core.current_config_id(), ARRAY['payment_attempts_per_minute'], 10) THEN
    PERFORM core.fail('RATE_LIMITED', 'too many payment attempts; try again in a minute');
  END IF;
  IF p_method = 'CARD' AND p_card_id IS NULL THEN
    PERFORM core.fail('VALIDATION_FAILED', 'cardId must be a uuid');
  END IF;
  IF p_method <> 'CARD' AND p_card_id IS NOT NULL THEN
    PERFORM core.fail('VALIDATION_FAILED', 'a card is only given for CARD payments');
  END IF;
  IF p_method = 'DELULUPAY_ID' AND (p_delulupay_id IS NULL OR char_length(p_delulupay_id) > 80) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'give your DeluluPay ID');
  END IF;
  IF p_method <> 'DELULUPAY_ID' AND p_delulupay_id IS NOT NULL THEN
    PERFORM core.fail('VALIDATION_FAILED', 'a DeluluPay ID is only given for DELULUPAY_ID payments');
  END IF;
  SELECT cs.state, cs.type, cs.total_paise, cs.expires_at <= clock_timestamp() AS expired INTO s
    FROM core.checkout_session cs WHERE cs.id = p_session_id AND cs.user_id = actor;
  IF NOT FOUND THEN
    PERFORM core.fail('NOT_FOUND', 'checkout session not found');
  END IF;
  IF s.state <> 'OPEN' THEN
    PERFORM core.fail('CONFLICT', 'checkout session is no longer open');
  END IF;
  IF s.expired THEN
    PERFORM core.fail('CHECKOUT_EXPIRED', 'checkout session has expired');
  END IF;
  IF p_method IN ('DELULUPAY_ID', 'NET_BANKING') AND s.type <> 'PRODUCT_PURCHASE' THEN
    PERFORM core.fail('METHOD_UNAVAILABLE', 'That payment method is not available for this payment. No fictional money moved.');
  END IF;

  -- the typed DeluluPay ID: the payer's own, or (staff and staging only) a reserved test ID
  IF p_method = 'DELULUPAY_ID' THEN
    v_id := lower(btrim(p_delulupay_id));
    IF v_id !~ '^[a-z0-9][a-z0-9._-]{1,40}@delulu$' THEN
      PERFORM core.fail('VALIDATION_FAILED', 'DeluluPay IDs end in @delulu');
    END IF;
    SELECT lower(ba.upi_style_id) INTO v_own FROM core.bank_account ba WHERE ba.user_id = actor;
    IF v_id LIKE 'testpay.%' THEN
      IF NOT core.payment_scenarios_allowed(actor) OR core.payment_scenario_of_test_id(v_id) IS NULL
         OR (v_scenario IS NOT NULL AND v_scenario <> core.payment_scenario_of_test_id(v_id)) THEN
        PERFORM core.fail('VALIDATION_FAILED', 'enter your own DeluluPay ID');
      END IF;
      v_scenario := core.payment_scenario_of_test_id(v_id);
    ELSIF v_own IS DISTINCT FROM v_id THEN
      PERFORM core.fail('VALIDATION_FAILED', 'enter your own DeluluPay ID');
    END IF;
  END IF;
  IF v_scenario IS NOT NULL
     AND (v_scenario <> ALL (core.payment_scenario_names()) OR NOT core.payment_scenarios_allowed(actor)) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'unknown scenario');
  END IF;

  -- availability and limits (PRD R4.2, R7): off, in maintenance, over a limit
  PERFORM core.payment_method_gate(actor, p_method, s.total_paise);

  IF p_method = 'CARD' THEN
    SELECT vc.status, vc.merchant_scope INTO c FROM core.virtual_card vc
     WHERE vc.id = p_card_id AND vc.user_id = actor;
    IF NOT FOUND THEN
      PERFORM core.fail('CARD_NOT_OWNED', 'card not found for this user');
    ELSIF c.status = 'FROZEN' THEN
      PERFORM core.fail('CARD_FROZEN', 'card is frozen');
    ELSIF c.status <> 'ACTIVE' THEN
      PERFORM core.fail('CARD_REPLACED', 'card has been replaced');
    ELSIF c.merchant_scope <> 'DELULUMART' THEN
      PERFORM core.fail('MERCHANT_NOT_ALLOWED', 'card cannot be used here');
    END IF;
  END IF;
  INSERT INTO core.payment_attempt (id, session_id, user_id, method, card_id, reference, scenario)
  VALUES (aid, p_session_id, actor, p_method, p_card_id, ref, v_scenario);
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  RETURN jsonb_build_object('attemptId', aid, 'reference', ref, 'method', p_method,
                            'authenticated', p_method = 'BALANCE');
END $$;

CREATE OR REPLACE FUNCTION core.create_payment_attempt(session_id uuid, method text, card_id uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
  SELECT core.start_payment_attempt(session_id, method, card_id, NULL, NULL)
$$;

-- ---------------------------------------------------------------- issue a code or an approval request
-- For the actor's newest PENDING attempt on the session. Returns {status: ISSUED, ...} (never the code), or
-- {status: FAILED, code} when the attempt ended (a committed trace). Raises NOT_FOUND, CONFLICT, RATE_LIMITED.
CREATE FUNCTION core.issue_payment_challenge(p_session_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor    uuid := core.actor_id();
  s        record;
  a        record;
  ch       record;
  v_kind   text;
  v_ttl    int := core.payment_setting('challenge_ttl_seconds');
  v_resend int := core.payment_setting('challenge_resend_seconds');
  v_code   text;
  v_now    timestamptz := clock_timestamp();
  v_exp    timestamptz;
  v_avail  timestamptz;
  v_m      record;
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  PERFORM ledger.require_read_committed();
  IF p_session_id IS NULL THEN
    PERFORM core.fail('VALIDATION_FAILED', 'sessionId must be a uuid');
  END IF;
  -- #1 the checkout session
  SELECT cs.state, cs.total_paise, cs.expires_at <= clock_timestamp() AS expired INTO s
    FROM core.checkout_session cs WHERE cs.id = p_session_id AND cs.user_id = actor FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM core.fail('NOT_FOUND', 'checkout session not found');
  END IF;
  IF s.state <> 'OPEN' THEN
    PERFORM core.fail('CONFLICT', 'checkout session is no longer open');
  END IF;
  SELECT pa.id, pa.method, pa.reference, pa.scenario, pa.authenticated_at INTO a
    FROM core.payment_attempt pa
   WHERE pa.session_id = p_session_id AND pa.user_id = actor AND pa.state = 'PENDING'
   ORDER BY pa.created_at DESC, pa.id DESC LIMIT 1 FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM core.fail('NOT_FOUND', 'no payment attempt is waiting on this checkout');
  END IF;
  IF a.method NOT IN ('DELULUPAY_ID', 'NET_BANKING') THEN
    PERFORM core.fail('CONFLICT', 'this payment method has no code or approval step');
  END IF;
  IF a.authenticated_at IS NOT NULL THEN
    PERFORM core.fail('CONFLICT', 'this payment is already authenticated');
  END IF;
  IF s.expired THEN
    PERFORM core.payment_attempt_fail(a.id, 'CHECKOUT_EXPIRED');
    RETURN jsonb_build_object('status', 'FAILED', 'code', 'CHECKOUT_EXPIRED', 'attemptId', a.id, 'method', a.method);
  END IF;
  SELECT * INTO v_m FROM core.payment_methods_now() m WHERE m.method = a.method;
  IF NOT v_m.available THEN
    PERFORM core.payment_attempt_fail(a.id, 'METHOD_UNAVAILABLE');
    RETURN jsonb_build_object('status', 'FAILED', 'code', 'METHOD_UNAVAILABLE', 'attemptId', a.id, 'method', a.method);
  END IF;
  -- the bank cannot be reached (test scenario): the attempt ends, nothing moved
  IF a.scenario = 'BANK_UNAVAILABLE' THEN
    PERFORM core.payment_attempt_fail(a.id, 'BANK_UNAVAILABLE');
    RETURN jsonb_build_object('status', 'FAILED', 'code', 'BANK_UNAVAILABLE', 'attemptId', a.id, 'method', a.method);
  END IF;
  v_kind := CASE a.method WHEN 'NET_BANKING' THEN 'CODE' ELSE 'APPROVE' END;

  SELECT * INTO ch FROM core.payment_challenge pc WHERE pc.attempt_id = a.id FOR UPDATE;
  IF FOUND THEN
    IF ch.passed_at IS NOT NULL THEN
      PERFORM core.fail('CONFLICT', 'this payment is already authenticated');
    END IF;
    IF v_now < ch.issued_at + make_interval(secs => v_resend) THEN
      PERFORM core.fail('RATE_LIMITED', format('You can ask again in %s seconds.',
        GREATEST(1, ceil(extract(epoch FROM ch.issued_at + make_interval(secs => v_resend) - v_now))::int)));
    END IF;
  END IF;
  -- codes and requests issued per account per hour; the count is the actor's own, so no one else can use it up
  PERFORM core.lock_actor('core.bank_inbox_message', actor);
  -- the actor's codes that ran out of time are scrubbed (the daily purge does it for everyone, 0103)
  UPDATE core.bank_inbox_message m SET code = NULL, cleared_at = v_now
   WHERE m.user_id = actor AND m.cleared_at IS NULL AND m.expires_at <= v_now;
  IF (SELECT count(*) FROM core.bank_inbox_message m
       WHERE m.user_id = actor AND m.created_at > v_now - interval '1 hour')
     >= core.payment_setting('challenge_codes_per_hour') THEN
    PERFORM core.fail('RATE_LIMITED', 'Too many codes asked for this hour. Try again later.');
  END IF;

  v_exp := CASE WHEN a.scenario = 'CODE_EXPIRED' THEN v_now ELSE v_now + make_interval(secs => v_ttl) END;
  v_avail := CASE WHEN a.scenario = 'SLOW_BANK'
                  THEN v_now + make_interval(secs => core.payment_setting('challenge_slow_bank_seconds')) END;
  v_code := CASE v_kind WHEN 'CODE' THEN core.payment_new_code() END;

  -- an earlier code or request of this attempt is superseded (its code scrubbed)
  UPDATE core.bank_inbox_message m SET code = NULL, cleared_at = v_now
   WHERE m.attempt_id = a.id AND m.cleared_at IS NULL;
  INSERT INTO core.payment_challenge (attempt_id, kind, code_hash, expires_at, issued_at, available_at)
  VALUES (a.id, v_kind, CASE WHEN v_code IS NOT NULL THEN core.payment_code_hash(a.id, v_code) END, v_exp, v_now, v_avail)
  ON CONFLICT (attempt_id) DO UPDATE
     SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, issued_at = EXCLUDED.issued_at,
         available_at = EXCLUDED.available_at, issue_count = core.payment_challenge.issue_count + 1;
  INSERT INTO core.bank_inbox_message (id, user_id, attempt_id, kind, code, amount_paise, created_at, expires_at, available_at)
  VALUES (core.uuid_v7(), actor, a.id, CASE v_kind WHEN 'CODE' THEN 'CODE' ELSE 'APPROVAL' END, v_code,
          s.total_paise, v_now, v_exp, v_avail);
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  RETURN jsonb_build_object('status', 'ISSUED', 'attemptId', a.id, 'reference', a.reference, 'method', a.method,
                            'kind', v_kind, 'expiresAt', v_exp, 'resendAfterSeconds', v_resend,
                            'availableAt', v_avail);
END $$;

-- ---------------------------------------------------------------- verify
-- p_code for a CODE challenge (net banking), p_decision 'APPROVE' or 'DECLINE' for an approval request
-- (DeluluPay ID). Returns {status}: AUTHENTICATED; WAITING (slow bank; retryAfterSeconds); INCORRECT
-- (remainingTries); FAILED (code: CHALLENGE_LOCKED, CHALLENGE_EXPIRED, CANCELLED, INSUFFICIENT_FUNDS,
-- METHOD_UNAVAILABLE, CHECKOUT_EXPIRED). The counters and the failure commit with the call.
CREATE FUNCTION core.verify_payment_challenge(p_session_id uuid, p_code text, p_decision text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor  uuid := core.actor_id();
  s      record;
  a      record;
  ch     record;
  v_tries int := core.payment_setting('challenge_tries');
  v_now  timestamptz := clock_timestamp();
  v_ok   boolean;
  v_used int;
  v_m    record;
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  PERFORM ledger.require_read_committed();
  IF p_session_id IS NULL THEN
    PERFORM core.fail('VALIDATION_FAILED', 'sessionId must be a uuid');
  END IF;
  IF (p_code IS NULL) = (p_decision IS NULL) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'give a code or a decision');
  END IF;
  IF p_code IS NOT NULL AND p_code !~ '^[0-9]{6}$' THEN
    PERFORM core.fail('VALIDATION_FAILED', 'a code is six digits');
  END IF;
  IF p_decision IS NOT NULL AND p_decision NOT IN ('APPROVE', 'DECLINE') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'the decision is APPROVE or DECLINE');
  END IF;
  -- #1 the checkout session
  SELECT cs.state, cs.expires_at <= clock_timestamp() AS expired INTO s
    FROM core.checkout_session cs WHERE cs.id = p_session_id AND cs.user_id = actor FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM core.fail('NOT_FOUND', 'checkout session not found');
  END IF;
  IF s.state <> 'OPEN' THEN
    PERFORM core.fail('CONFLICT', 'checkout session is no longer open');
  END IF;
  SELECT pa.id, pa.method, pa.scenario, pa.authenticated_at INTO a
    FROM core.payment_attempt pa
   WHERE pa.session_id = p_session_id AND pa.user_id = actor AND pa.state = 'PENDING'
   ORDER BY pa.created_at DESC, pa.id DESC LIMIT 1 FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM core.fail('NOT_FOUND', 'no payment attempt is waiting on this checkout');
  END IF;
  IF a.method NOT IN ('DELULUPAY_ID', 'NET_BANKING') THEN
    PERFORM core.fail('CONFLICT', 'this payment method has no code or approval step');
  END IF;
  IF a.authenticated_at IS NOT NULL THEN
    PERFORM core.fail('CONFLICT', 'this payment is already authenticated');
  END IF;
  SELECT * INTO ch FROM core.payment_challenge pc WHERE pc.attempt_id = a.id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM core.fail('CONFLICT', 'ask for a code or an approval request first');
  END IF;
  IF ch.passed_at IS NOT NULL THEN
    PERFORM core.fail('CONFLICT', 'this payment is already authenticated');
  END IF;
  IF (ch.kind = 'CODE') <> (p_code IS NOT NULL) THEN
    PERFORM core.fail('VALIDATION_FAILED', CASE ch.kind WHEN 'CODE' THEN 'give the code from the bank inbox'
                                           ELSE 'approve or decline the request in the bank inbox' END);
  END IF;
  IF s.expired THEN
    PERFORM core.payment_attempt_fail(a.id, 'CHECKOUT_EXPIRED');
    RETURN jsonb_build_object('status', 'FAILED', 'code', 'CHECKOUT_EXPIRED', 'attemptId', a.id, 'method', a.method);
  END IF;
  SELECT * INTO v_m FROM core.payment_methods_now() m WHERE m.method = a.method;
  IF NOT v_m.available THEN
    PERFORM core.payment_attempt_fail(a.id, 'METHOD_UNAVAILABLE');
    RETURN jsonb_build_object('status', 'FAILED', 'code', 'METHOD_UNAVAILABLE', 'attemptId', a.id, 'method', a.method);
  END IF;
  -- a slow bank has not answered yet (test scenario)
  IF ch.available_at IS NOT NULL AND v_now < ch.available_at THEN
    RETURN jsonb_build_object('status', 'WAITING', 'attemptId', a.id, 'method', a.method,
                              'retryAfterSeconds', GREATEST(1, ceil(extract(epoch FROM ch.available_at - v_now))::int));
  END IF;
  IF v_now >= ch.expires_at THEN
    PERFORM core.payment_attempt_fail(a.id, 'CHALLENGE_EXPIRED');
    RETURN jsonb_build_object('status', 'FAILED', 'code', 'CHALLENGE_EXPIRED', 'attemptId', a.id, 'method', a.method);
  END IF;

  IF ch.kind = 'APPROVE' THEN
    IF p_decision = 'DECLINE' THEN
      PERFORM core.payment_attempt_fail(a.id, 'CANCELLED');
      RETURN jsonb_build_object('status', 'FAILED', 'code', 'CANCELLED', 'attemptId', a.id, 'method', a.method);
    END IF;
    v_ok := a.scenario IS DISTINCT FROM 'CODE_LOCKOUT';
  ELSE
    v_ok := a.scenario IS DISTINCT FROM 'CODE_LOCKOUT'
            AND ch.code_hash = core.payment_code_hash(a.id, p_code);
  END IF;

  IF v_ok THEN
    IF a.scenario = 'INSUFFICIENT_FUNDS' THEN
      PERFORM core.payment_attempt_fail(a.id, 'INSUFFICIENT_FUNDS');
      RETURN jsonb_build_object('status', 'FAILED', 'code', 'INSUFFICIENT_FUNDS', 'attemptId', a.id, 'method', a.method);
    END IF;
    UPDATE core.payment_challenge pc SET passed_at = clock_timestamp() WHERE pc.attempt_id = a.id;
    UPDATE core.payment_attempt pa SET authenticated_at = clock_timestamp() WHERE pa.id = a.id;
    UPDATE core.bank_inbox_message m SET code = NULL, cleared_at = clock_timestamp()
     WHERE m.attempt_id = a.id AND m.cleared_at IS NULL;
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
    RETURN jsonb_build_object('status', 'AUTHENTICATED', 'attemptId', a.id, 'method', a.method);
  END IF;

  -- wrong code (or an approval the scenario never lets through): counted, committed
  v_used := ch.attempts_used + 1;
  UPDATE core.payment_challenge pc SET attempts_used = v_used WHERE pc.attempt_id = a.id;
  IF v_used >= v_tries THEN
    PERFORM core.payment_attempt_fail(a.id, 'CHALLENGE_LOCKED');
    RETURN jsonb_build_object('status', 'FAILED', 'code', 'CHALLENGE_LOCKED', 'attemptId', a.id, 'method', a.method);
  END IF;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  RETURN jsonb_build_object('status', 'INCORRECT', 'attemptId', a.id, 'method', a.method, 'remainingTries', v_tries - v_used);
END $$;

-- ---------------------------------------------------------------- cancel
-- "Cancelled by you": the actor ends their own PENDING attempt (any method). No money moved.
CREATE FUNCTION core.cancel_payment_attempt(p_attempt_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor uuid := core.actor_id();
  v_session uuid;
  a record;
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  PERFORM ledger.require_read_committed();
  SELECT pa.session_id INTO v_session FROM core.payment_attempt pa WHERE pa.id = p_attempt_id AND pa.user_id = actor;
  IF NOT FOUND THEN
    PERFORM core.fail('NOT_FOUND', 'payment attempt not found');
  END IF;
  -- #1 the checkout session, then the attempt
  PERFORM 1 FROM core.checkout_session cs WHERE cs.id = v_session AND cs.user_id = actor FOR NO KEY UPDATE;
  SELECT pa.id, pa.state, pa.method INTO a FROM core.payment_attempt pa WHERE pa.id = p_attempt_id FOR NO KEY UPDATE;
  IF a.state <> 'PENDING' THEN
    PERFORM core.fail('CONFLICT', 'this payment is no longer pending');
  END IF;
  PERFORM core.payment_attempt_fail(a.id, 'CANCELLED');
  RETURN jsonb_build_object('status', 'FAILED', 'code', 'CANCELLED', 'attemptId', a.id, 'method', a.method);
END $$;

-- ---------------------------------------------------------------- privileges
REVOKE ALL ON FUNCTION
  core.payment_scenarios_allowed(uuid), core.payment_scenario_of_test_id(text), core.payment_scenario_names(),
  core.payment_attempt_fail(uuid, text), core.payment_new_code(), core.payment_code_hash(uuid, text),
  core.start_payment_attempt(uuid, text, uuid, text, text), core.issue_payment_challenge(uuid),
  core.verify_payment_challenge(uuid, text, text), core.cancel_payment_attempt(uuid)
  FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;
GRANT EXECUTE ON FUNCTION core.start_payment_attempt(uuid, text, uuid, text, text), core.issue_payment_challenge(uuid),
  core.verify_payment_challenge(uuid, text, text), core.cancel_payment_attempt(uuid) TO app_pay;
