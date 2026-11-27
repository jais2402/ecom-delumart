-- Review fixes for the DeluluPay series (0100-0103; decisions.md #17). 0100-0103 are not edited.
--
--  * The queue cannot stop all payments (review major 2). core.payment_end_state_usable evaluates the END
--    STATE of a proposed payment_method.set, at proposal and again when it runs: after the change at least
--    one method must be enabled, switched on, outside a maintenance window at any time during the window
--    being set (or at this instant when none is set) and have per-attempt and per-day limits at or above
--    floors (configuration keys payment_limit_floor_attempt_paise, payment_limit_floor_day_paise, defaults
--    ₹1 lakh and ₹10 lakh, clamped). The old core.payment_one_method_stays, which ignored windows and limits,
--    is dropped. Several queued actions are each checked against the state when they run, so the last one that
--    would leave nothing usable is refused (FAILED, CONFIG_VALUE_INVALID).
--  * The per-day limit counts a payment toward the UTC day it was PAID (order group or company registration
--    creation time), not the day its attempt was created, so an attempt made at 23:59 cannot dodge a limit.
--  * A company registration is gated at pay like a purchase (core.commit_company_registration re-created from
--    0034 with the one added PERFORM).
--  * The proposal's audit row carries the full proposed values of a payment_method.set (no personal data); the
--    execution row too.
--  * Codes per hour default to 10 (approvals and codes count together); rows of the bank inbox older than
--    bank_inbox_retention_days (30) are deleted by the daily purge (codes were already scrubbed).
--  * A code is not shown in the inbox before the (test) slow bank's available_at.
--  * The INSUFFICIENT_FUNDS test scenario stores TEST_INSUFFICIENT_FUNDS, so a forced decline never looks like a
--    real insufficient-funds reason on the Payments page.

-- ---------------------------------------------------------------- settings
CREATE OR REPLACE FUNCTION core.payment_setting_defaults() RETURNS TABLE (key text, dflt int, lo int, hi int)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.key, d.dflt, d.lo, d.hi
    FROM (VALUES ('challenge_ttl_seconds', 180, 30, 900),
                 ('challenge_tries', 3, 1, 10),
                 ('challenge_resend_seconds', 30, 5, 600),
                 ('challenge_codes_per_hour', 10, 1, 60),
                 ('challenge_slow_bank_seconds', 8, 1, 60),
                 ('payment_maintenance_max_hours', 336, 1, 2160),
                 ('payments_page_size', 20, 1, 50),
                 ('bank_inbox_max', 10, 1, 50),
                 ('bank_inbox_retention_days', 30, 1, 365)) AS d(key, dflt, lo, hi)
$$;

-- The smallest limits a method may have and still count as usable (paise; clamped).
CREATE FUNCTION core.payment_limit_floors() RETURNS TABLE (per_attempt bigint, per_day bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT GREATEST(100, LEAST(core.config_paise(core.current_config_id(), ARRAY['payment_limit_floor_attempt_paise'], 10000000), 10000000000000)),
         GREATEST(100, LEAST(core.config_paise(core.current_config_id(), ARRAY['payment_limit_floor_day_paise'], 100000000), 10000000000000))
$$;

-- ---------------------------------------------------------------- the end state of a change
CREATE FUNCTION core.payment_end_state_usable(p_payload jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_method text := p_payload ->> 'method';
  v_from   timestamptz := (p_payload ->> 'maintenanceFrom')::timestamptz;
  v_until  timestamptz := (p_payload ->> 'maintenanceUntil')::timestamptz;
  v_now    timestamptz := clock_timestamp();
  f        record;
BEGIN
  SELECT * INTO f FROM core.payment_limit_floors();
  -- the span to protect: the window being set, or the present instant when there is none
  IF v_from IS NULL THEN
    v_from := v_now;
    v_until := v_now + interval '1 microsecond';
  END IF;
  RETURN EXISTS (
    SELECT 1
      FROM (SELECT m.method, m.switch_on,
                   CASE WHEN m.method = v_method THEN (p_payload ->> 'enabled')::boolean ELSE m.enabled END AS enabled,
                   CASE WHEN m.method = v_method THEN (p_payload ->> 'perAttemptLimitPaise')::bigint ELSE m.per_attempt_limit_paise END AS per_attempt,
                   CASE WHEN m.method = v_method THEN (p_payload ->> 'perDayLimitPaise')::bigint ELSE m.per_day_limit_paise END AS per_day,
                   CASE WHEN m.method = v_method THEN (p_payload ->> 'maintenanceFrom')::timestamptz ELSE m.maintenance_from END AS mf,
                   CASE WHEN m.method = v_method THEN (p_payload ->> 'maintenanceUntil')::timestamptz ELSE m.maintenance_until END AS mu
              FROM core.payment_methods_now() m) s
     WHERE s.enabled AND s.switch_on
       AND (s.per_attempt IS NULL OR s.per_attempt >= f.per_attempt)
       AND (s.per_day IS NULL OR s.per_day >= f.per_day)
       AND (s.mf IS NULL OR NOT (s.mf < v_until AND s.mu > v_from)));
END $$;

-- ---------------------------------------------------------------- propose, execute (0100)
CREATE OR REPLACE FUNCTION core.admin_action_propose(p_kind text, p_payload jsonb, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_actor   uuid := core.admin_actor();
  v_reason  text;
  v_payload jsonb;
  v_reg     record;
  v_base    int;
  v_current bigint;
  v_id      uuid := core.uuid_v7();
  v_when    timestamptz;
  v_row     audit.pending_action;
BEGIN
  PERFORM core.require_recent_sign_in();             -- owner-only action (R16.6)
  v_reason := core.admin_reason(p_reason);
  v_payload := core.admin_action_validate(p_kind, p_payload);
  -- one proposal at a time per Super Admin, so the cap and the duplicate check cannot be raced
  PERFORM core.lock_actor('audit.pending_action', v_actor);
  IF (SELECT count(*) FROM audit.pending_action a WHERE a.state = 'QUEUED') >= core.admin_action_setting('admin_action_open_max') THEN
    PERFORM core.fail('ADMIN_ACTION_LIMIT', 'too many changes are waiting; cancel or wait for one first');
  END IF;
  IF EXISTS (SELECT 1 FROM audit.pending_action a
              WHERE a.state = 'QUEUED' AND a.action = p_kind AND a.payload ->> 'key' = v_payload ->> 'key') THEN
    PERFORM core.fail('CONFLICT', 'a change to this setting is already waiting');
  END IF;
  IF p_kind = 'config.set' THEN
    SELECT * INTO v_reg FROM core.config_key_registry() r WHERE r.key = v_payload ->> 'key';
    v_base := core.admin_config_base_id();
    v_current := CASE v_reg.kind WHEN 'paise' THEN core.config_paise(v_base, v_reg.path, v_reg.default_value)
                                 ELSE core.config_int(v_base, v_reg.path, v_reg.default_value) END;
    IF v_current = (v_payload ->> 'value')::bigint THEN
      PERFORM core.fail('CONFLICT', 'that is already the value');
    END IF;
  ELSIF p_kind = 'payment_method.set' THEN
    IF core.payment_method_unchanged(v_payload) THEN
      PERFORM core.fail('CONFLICT', 'that is already the setting');
    END IF;
    IF NOT core.payment_end_state_usable(v_payload) THEN
      PERFORM core.fail('CONFIG_VALUE_INVALID', 'after this change at least one payment method must stay usable: enabled, switched on, outside a maintenance window and above the minimum limits');
    END IF;
  END IF;
  v_when := clock_timestamp() + make_interval(secs => core.admin_action_setting('admin_action_delay_seconds'));
  INSERT INTO audit.pending_action (id, action, payload, payload_hash, requested_by, not_before, reason)
  VALUES (v_id, p_kind, v_payload, sha256(convert_to(v_payload::text, 'UTF8')), v_actor, v_when, v_reason)
  RETURNING * INTO v_row;
  PERFORM core.admin_audit(v_actor, 'admin_action.propose', 'admin_action', v_id::text, v_reason,
                           jsonb_build_object('kind', p_kind, 'key', v_payload ->> 'key', 'value', v_payload ->> 'value',
                                              'notBefore', v_when)
                           || CASE WHEN p_kind = 'payment_method.set' THEN jsonb_build_object('proposed', v_payload - 'key') ELSE '{}'::jsonb END);
  PERFORM core.admin_action_notify('admin_action_proposed', v_id, p_kind, v_payload ->> 'key', v_when);
  RETURN core.admin_action_json(v_row);
END $$;

CREATE OR REPLACE FUNCTION core.admin_action_apply_payment_method_set(p_action uuid, p_payload jsonb, p_requested_by uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_method text := p_payload ->> 'method';
  v_version int;
BEGIN
  -- one writer per method, so two executions in one run cannot take the same version number
  PERFORM pg_advisory_xact_lock(hashtextextended('core.payment_method_config:' || v_method, 0));
  IF core.payment_method_unchanged(p_payload) THEN
    RETURN jsonb_build_object('changed', false,
      'configVersion', (SELECT m.version FROM core.payment_methods_now() m WHERE m.method = v_method));
  END IF;
  IF NOT core.payment_end_state_usable(p_payload) THEN
    PERFORM core.fail('CONFIG_VALUE_INVALID', 'after this change at least one payment method must stay usable');
  END IF;
  SELECT COALESCE(max(pc.version), 0) + 1 INTO v_version FROM core.payment_method_config pc WHERE pc.method = v_method;
  INSERT INTO core.payment_method_config (id, method, version, enabled, display_order, per_attempt_limit_paise,
                                          per_day_limit_paise, maintenance_from, maintenance_until, action_id,
                                          created_by, reason)
  VALUES (core.uuid_v7(), v_method, v_version, (p_payload ->> 'enabled')::boolean, (p_payload ->> 'displayOrder')::int,
          (p_payload ->> 'perAttemptLimitPaise')::bigint, (p_payload ->> 'perDayLimitPaise')::bigint,
          (p_payload ->> 'maintenanceFrom')::timestamptz, (p_payload ->> 'maintenanceUntil')::timestamptz,
          p_action, p_requested_by, p_reason);
  BEGIN
    -- no user id, no visitor and no values; a database-only server event (analytics.record_event refuses it)
    INSERT INTO analytics.event (occurred_at, day, name, surface, visitor_key, signed_in, country, region, city,
                                 device_class, props)
    VALUES (date_trunc('hour', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
            (clock_timestamp() AT TIME ZONE 'UTC')::date, 'console_config_changed', 'console', NULL, true, 'ZZ',
            NULL, NULL, 'unknown', '{}'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    NULL;   -- analytics never blocks a configuration change
  END;
  PERFORM audit.append_chained(NULL, 'SYSTEM', 'admin_action.execute', 'admin_action', p_action::text, p_reason,
    jsonb_build_object('kind', 'payment_method.set', 'key', p_payload ->> 'key', 'version', v_version,
                       'applied', p_payload - 'key', 'requestedBy', p_requested_by));
  RETURN jsonb_build_object('changed', true, 'configVersion', v_version);
END $$;

DROP FUNCTION core.payment_one_method_stays(text, boolean);

-- ---------------------------------------------------------------- the daily limit counts the day of payment
CREATE OR REPLACE FUNCTION core.payment_method_used_today(p_actor uuid, p_method text) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE(sum(cs.total_paise), 0)::bigint
    FROM core.payment_attempt pa
    JOIN core.checkout_session cs ON cs.id = pa.session_id
    LEFT JOIN core.order_group g ON g.payment_attempt_id = pa.id
    LEFT JOIN core.company_registration cr ON cr.payment_attempt_id = pa.id
   WHERE pa.user_id = p_actor AND pa.method = p_method AND pa.state = 'SUCCEEDED'
     AND COALESCE(g.created_at, cr.created_at, pa.created_at)
         >= (date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
$$;

-- ---------------------------------------------------------------- company registration is gated at pay
CREATE OR REPLACE FUNCTION core.commit_company_registration(session_id uuid, attempt_id uuid, idempotency_key text,
                                                 request_hash bytea) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor   uuid := core.actor_id();
  rec     core.idempotency_record;
  receipt jsonb;
  code    text;
  msg     text;
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  PERFORM ledger.require_read_committed();
  IF session_id IS NULL OR attempt_id IS NULL OR request_hash IS NULL THEN
    PERFORM core.fail('VALIDATION_FAILED', 'session, attempt and request hash are required');
  END IF;
  rec := core.idem_begin(actor, 'company.register', idempotency_key, request_hash);
  IF rec.status = 200 THEN
    RETURN jsonb_build_object('status', 'SUCCEEDED', 'replayed', true, 'receipt', rec.response);
  ELSIF rec.status IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'FAILED', 'replayed', true, 'error', rec.response -> 'error');
  END IF;
  IF NOT core.switch_on('purchases') THEN
    PERFORM core.fail('MAINTENANCE', 'payments are switched off');
  END IF;
  BEGIN
    -- the method's availability and limits, as at the pay step of a purchase (0102)
    PERFORM core.payment_method_gate_for_pay(actor, commit_company_registration.session_id,
                                             commit_company_registration.attempt_id);
    receipt := core.company_registration_write(actor, commit_company_registration.session_id,
                                               commit_company_registration.attempt_id);
    UPDATE core.idempotency_record r SET status = 200, response = receipt
     WHERE r.user_id = actor AND r.command = 'company.register' AND r.key = idempotency_key;
    RETURN jsonb_build_object('status', 'SUCCEEDED', 'replayed', false, 'receipt', receipt);
  EXCEPTION WHEN SQLSTATE 'DM001' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT, code = PG_EXCEPTION_HINT;
    IF code = 'PAYMENT_PENDING' THEN
      RAISE;   -- retryable once the challenge is complete
    END IF;
  END;
  UPDATE core.idempotency_record r
     SET status = 422, response = jsonb_build_object('error', jsonb_build_object('code', code, 'message', msg))
   WHERE r.user_id = actor AND r.command = 'company.register' AND r.key = idempotency_key;
  UPDATE core.payment_attempt pa SET state = 'FAILED', failure_code = code
   WHERE pa.id = commit_company_registration.attempt_id AND pa.session_id = commit_company_registration.session_id
     AND pa.user_id = actor AND pa.state = 'PENDING';
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  RETURN jsonb_build_object('status', 'FAILED', 'replayed', false,
                            'error', jsonb_build_object('code', code, 'message', msg));
END $$;

-- ---------------------------------------------------------------- verify: a forced decline is marked as one
CREATE OR REPLACE FUNCTION core.verify_payment_challenge(p_session_id uuid, p_code text, p_decision text) RETURNS jsonb
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
      PERFORM core.payment_attempt_fail(a.id, 'TEST_INSUFFICIENT_FUNDS');
      RETURN jsonb_build_object('status', 'FAILED', 'code', 'TEST_INSUFFICIENT_FUNDS', 'attemptId', a.id, 'method', a.method);
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

-- ---------------------------------------------------------------- inbox: no code before the slow bank answers
CREATE OR REPLACE FUNCTION core.my_bank_inbox() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := core.actor_id();
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  RETURN jsonb_build_object('items', COALESCE((SELECT jsonb_agg(x.j ORDER BY x.created_at DESC, x.id DESC) FROM (
    SELECT m.id, m.created_at,
           jsonb_build_object(
             'id', m.id, 'kind', m.kind, 'attemptId', m.attempt_id, 'sessionId', pa.session_id,
             'reference', pa.reference, 'amountPaise', m.amount_paise::text,
             'createdAt', m.created_at, 'expiresAt', m.expires_at, 'availableAt', m.available_at,
             'status', CASE WHEN m.cleared_at IS NULL AND pa.state = 'PENDING' AND m.expires_at > clock_timestamp() THEN 'OPEN'
                            WHEN pa.state = 'SUCCEEDED' OR pa.authenticated_at IS NOT NULL THEN 'USED'
                            WHEN m.expires_at <= clock_timestamp() THEN 'EXPIRED'
                            ELSE 'CLOSED' END,
             'code', CASE WHEN m.kind = 'CODE' AND m.cleared_at IS NULL AND m.code IS NOT NULL
                               AND pa.state = 'PENDING' AND m.expires_at > clock_timestamp()
                               AND (m.available_at IS NULL OR m.available_at <= clock_timestamp())
                          THEN m.code END) AS j
      FROM core.bank_inbox_message m JOIN core.payment_attempt pa ON pa.id = m.attempt_id
     WHERE m.user_id = actor AND pa.user_id = actor
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT core.payment_setting('bank_inbox_max')) x), '[]'::jsonb));
END $$;

-- ---------------------------------------------------------------- the daily purge also trims the inbox
CREATE OR REPLACE FUNCTION core.purge_idempotency_records() RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n bigint;
BEGIN
  DELETE FROM core.idempotency_record r
   WHERE r.created_at < now() - make_interval(
           hours => core.config_int(core.current_config_id(), ARRAY['idempotency_retention_hours'], 24)::int);
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE core.bank_inbox_message m SET code = NULL, cleared_at = clock_timestamp()
   WHERE m.cleared_at IS NULL AND m.expires_at <= clock_timestamp();
  DELETE FROM core.bank_inbox_message m
   WHERE m.cleared_at IS NOT NULL
     AND m.created_at < clock_timestamp() - make_interval(days => core.payment_setting('bank_inbox_retention_days'));
  RETURN n;
END $$;

-- ---------------------------------------------------------------- privileges
REVOKE ALL ON FUNCTION core.payment_limit_floors(), core.payment_end_state_usable(jsonb)
  FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;
