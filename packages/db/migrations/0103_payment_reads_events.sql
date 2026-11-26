-- DeluluPay reads, the displayed status and the payment events (PRD R3 Payments, R4.3, R10; US-34, US-36).
--
--  * core.payment_display_status maps the stored PENDING / SUCCEEDED / FAILED state onto the status the
--    player sees: Created -> Authenticating -> Authorised -> Captured, or Failed (or Refunded after a staff
--    reversal). packages/core/src/pay displayStatus() is the same rule (a database test holds them equal).
--    "Authenticating" is the bank step: it moves no money and places no hold. A PENDING attempt whose
--    session is no longer open shows as Failed with the code CHECKOUT_EXPIRED (session expired), or
--    CANCELLED when its session was cancelled.
--  * core.my_payments: the actor's own payment attempts, newest first, with method, status, reference,
--    amount, decline code and (for a captured one) the order group. Keyset pagination on (created_at, id).
--    It names no one else and carries no code (US-34: a failed attempt shows here with a reason and nowhere
--    in the statement).
--  * core.my_payment_attempt: one attempt of the actor's own, for the bank page: the amount, the bank alias,
--    the challenge's timing (never its code) and the displayed status.
--  * core.my_bank_inbox: the in-app bank inbox of the actor. THE ONLY place a code is readable, and only the
--    payer's own, only while it is open (not expired, not used, not superseded, the attempt pending). No
--    event, log, outbox row or other response carries a code.
--  * core.checkout_payment_methods: what checkout offers the actor: each method in the configured order,
--    whether it is available now and why not (off, or maintenance and when it ends), the limits, and
--    whether test scenarios are open to this actor.
--  * analytics: payment_method_selected, payment_challenge_issued, payment_challenge_passed and
--    payment_challenge_failed join the allow-lists as SERVER events with one prop, `method` (one of the four
--    method names): no user id, no visitor, no code and no amount.

CREATE FUNCTION core.payment_display_status(p_state text, p_authenticated boolean, p_challenge_issued boolean,
                                            p_session_live boolean, p_reversed boolean) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
           WHEN p_state = 'SUCCEEDED' THEN CASE WHEN p_reversed THEN 'REFUNDED' ELSE 'CAPTURED' END
           WHEN p_state = 'FAILED' THEN 'FAILED'
           WHEN NOT p_session_live THEN 'FAILED'
           WHEN p_authenticated THEN 'AUTHORISED'
           WHEN p_challenge_issued THEN 'AUTHENTICATING'
           ELSE 'CREATED' END
$$;

-- ---------------------------------------------------------------- the actor's payments
CREATE FUNCTION core.my_payments(p_cursor text, p_limit int) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor  uuid := core.actor_id();
  v_max  int := core.payment_setting('payments_page_size');
  v_size int := LEAST(GREATEST(COALESCE(p_limit, v_max), 1), v_max);
  v_at   timestamptz;
  v_id   uuid;
  v_out  jsonb;
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  IF p_cursor IS NOT NULL THEN
    IF p_cursor !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{8,15}Z\|[0-9a-f-]{36}$' THEN
      PERFORM core.fail('VALIDATION_FAILED', 'cursor is not valid');
    END IF;
    BEGIN
      v_at := split_part(p_cursor, '|', 1)::timestamptz;
      v_id := split_part(p_cursor, '|', 2)::uuid;
    EXCEPTION WHEN OTHERS THEN
      PERFORM core.fail('VALIDATION_FAILED', 'cursor is not valid');
    END;
  END IF;
  WITH page AS (
    SELECT pa.id, pa.reference, pa.method, pa.state, pa.failure_code, pa.created_at,
           pa.authenticated_at IS NOT NULL AS authed, cs.total_paise,
           (cs.state = 'OPEN' AND cs.expires_at > clock_timestamp()) AS live, cs.state AS session_state,
           EXISTS (SELECT 1 FROM core.payment_challenge pc WHERE pc.attempt_id = pa.id) AS issued,
           g.id AS group_id,
           (g.id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.seller_order so
                                              WHERE so.order_group_id = g.id AND so.status <> 'REVERSED')) AS reversed,
           row_number() OVER (ORDER BY pa.created_at DESC, pa.id DESC) AS rn
      FROM core.payment_attempt pa
      JOIN core.checkout_session cs ON cs.id = pa.session_id
      LEFT JOIN core.order_group g ON g.payment_attempt_id = pa.id
     WHERE pa.user_id = actor AND (v_at IS NULL OR (pa.created_at, pa.id) < (v_at, v_id))
     ORDER BY pa.created_at DESC, pa.id DESC
     LIMIT v_size + 1)
  SELECT jsonb_build_object(
           'items', COALESCE((SELECT jsonb_agg(jsonb_build_object(
               'id', p.id, 'reference', p.reference, 'method', p.method,
               'status', core.payment_display_status(p.state, p.authed, p.issued, p.live, p.reversed),
               'failureCode', CASE WHEN p.state = 'FAILED' THEN p.failure_code
                                   WHEN p.state = 'PENDING' AND NOT p.live
                                   THEN CASE WHEN p.session_state = 'CANCELED' THEN 'CANCELLED' ELSE 'CHECKOUT_EXPIRED' END END,
               'amountPaise', p.total_paise::text, 'createdAt', p.created_at,
               'orderGroupId', p.group_id) ORDER BY p.rn) FROM page p WHERE p.rn <= v_size), '[]'::jsonb),
           'nextCursor', (SELECT to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || p.id::text
                            FROM page p WHERE p.rn = v_size
                             AND EXISTS (SELECT 1 FROM page q WHERE q.rn > v_size)))
    INTO v_out;
  RETURN v_out;
END $$;

-- ---------------------------------------------------------------- one attempt (the bank page)
CREATE FUNCTION core.my_payment_attempt(p_attempt uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := core.actor_id();
  a     record;
  ch    record;
  v_out jsonb;
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  SELECT pa.id, pa.session_id, pa.reference, pa.method, pa.state, pa.failure_code, pa.authenticated_at, pa.created_at,
         cs.total_paise, (cs.state = 'OPEN' AND cs.expires_at > clock_timestamp()) AS live, cs.state AS session_state,
         cs.expires_at, ba.alias, ba.upi_style_id,
         EXISTS (SELECT 1 FROM core.payment_challenge pc WHERE pc.attempt_id = pa.id) AS issued
    INTO a
    FROM core.payment_attempt pa
    JOIN core.checkout_session cs ON cs.id = pa.session_id
    LEFT JOIN core.bank_account ba ON ba.user_id = pa.user_id
   WHERE pa.id = p_attempt AND pa.user_id = actor;
  IF NOT FOUND THEN
    PERFORM core.fail('NOT_FOUND', 'payment attempt not found');
  END IF;
  SELECT pc.kind, pc.issued_at, pc.expires_at, pc.available_at, pc.attempts_used INTO ch
    FROM core.payment_challenge pc WHERE pc.attempt_id = a.id AND pc.kind <> 'PIN';
  v_out := jsonb_build_object(
    'id', a.id, 'sessionId', a.session_id, 'reference', a.reference, 'method', a.method,
    'status', core.payment_display_status(a.state, a.authenticated_at IS NOT NULL, a.issued, a.live, false),
    'failureCode', CASE WHEN a.state = 'FAILED' THEN a.failure_code
                        WHEN a.state = 'PENDING' AND NOT a.live
                        THEN CASE WHEN a.session_state = 'CANCELED' THEN 'CANCELLED' ELSE 'CHECKOUT_EXPIRED' END END,
    'authenticated', a.authenticated_at IS NOT NULL, 'amountPaise', a.total_paise::text,
    'bankAlias', a.alias, 'delulupayId', CASE WHEN a.method = 'DELULUPAY_ID' THEN a.upi_style_id END,
    'sessionExpiresAt', a.expires_at, 'createdAt', a.created_at);
  IF ch.kind IS NOT NULL THEN
    v_out := v_out || jsonb_build_object('challenge', jsonb_build_object(
      'kind', ch.kind, 'issuedAt', ch.issued_at, 'expiresAt', ch.expires_at, 'availableAt', ch.available_at,
      'triesLeft', GREATEST(0, core.payment_setting('challenge_tries') - ch.attempts_used),
      'resendAfterSeconds', GREATEST(0, ceil(extract(epoch FROM ch.issued_at
          + make_interval(secs => core.payment_setting('challenge_resend_seconds')) - clock_timestamp()))::int)));
  END IF;
  RETURN v_out;
END $$;

-- ---------------------------------------------------------------- the bank inbox
CREATE FUNCTION core.my_bank_inbox() RETURNS jsonb
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
                          THEN m.code END) AS j
      FROM core.bank_inbox_message m JOIN core.payment_attempt pa ON pa.id = m.attempt_id
     WHERE m.user_id = actor AND pa.user_id = actor
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT core.payment_setting('bank_inbox_max')) x), '[]'::jsonb));
END $$;

-- ---------------------------------------------------------------- what checkout offers
CREATE FUNCTION core.checkout_payment_methods() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := core.actor_id();
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  RETURN jsonb_build_object(
    'scenariosAllowed', core.payment_scenarios_allowed(actor),
    'methods', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'method', m.method, 'displayOrder', m.display_order, 'available', m.available,
        'reason', CASE WHEN m.in_maintenance THEN 'MAINTENANCE' WHEN NOT m.enabled OR NOT m.switch_on THEN 'OFF' END,
        'maintenanceUntil', CASE WHEN m.in_maintenance THEN m.maintenance_until END,
        'perAttemptLimitPaise', m.per_attempt_limit_paise::text,
        'perDayLimitPaise', m.per_day_limit_paise::text) ORDER BY m.display_order, m.method)
      FROM core.payment_methods_now() m), '[]'::jsonb));
END $$;

-- ---------------------------------------------------------------- analytics allow-lists (0061, 0090)
CREATE OR REPLACE FUNCTION analytics.event_names() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['page_view', 'search', 'product_view', 'cart_add', 'checkout_start',
               'purchase', 'sign_up', 'creator_unlock', 'shop_registered', 'listing_published',
               'review_submitted', 'review_hidden', 'console_config_changed',
               'payment_method_selected', 'payment_challenge_issued', 'payment_challenge_passed',
               'payment_challenge_failed']
$$;

CREATE OR REPLACE FUNCTION analytics.server_event_names() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['purchase', 'sign_up', 'creator_unlock', 'shop_registered', 'listing_published',
               'review_submitted', 'review_hidden', 'console_config_changed',
               'payment_method_selected', 'payment_challenge_issued', 'payment_challenge_passed',
               'payment_challenge_failed']
$$;

-- props_valid as of 0061, plus the one `method` prop of the four payment events
CREATE OR REPLACE FUNCTION analytics.props_valid(p_name text, p_props jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_props IS NOT NULL AND jsonb_typeof(p_props) = 'object' AND octet_length(p_props::text) <= 256
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_each(p_props) e
        WHERE e.key <> ALL (CASE p_name
                WHEN 'search'            THEN ARRAY['result_count_bucket', 'query_length_bucket']
                WHEN 'product_view'      THEN ARRAY['product_id', 'category', 'company_id']
                WHEN 'cart_add'          THEN ARRAY['product_id', 'category', 'company_id']
                WHEN 'listing_published' THEN ARRAY['category']
                WHEN 'checkout_start'    THEN ARRAY['item_count', 'amount_bucket']
                WHEN 'purchase'          THEN ARRAY['amount_bucket']
                WHEN 'payment_method_selected'  THEN ARRAY['method']
                WHEN 'payment_challenge_issued' THEN ARRAY['method']
                WHEN 'payment_challenge_passed' THEN ARRAY['method']
                WHEN 'payment_challenge_failed' THEN ARRAY['method']
                ELSE ARRAY[]::text[] END)
           OR NOT CASE e.key
                WHEN 'product_id' THEN jsonb_typeof(e.value) = 'string'
                  AND (e.value #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                WHEN 'company_id' THEN jsonb_typeof(e.value) = 'string'
                  AND (e.value #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                WHEN 'category' THEN jsonb_typeof(e.value) = 'string' AND (e.value #>> '{}') ~ '^[a-z0-9-]{1,40}$'
                WHEN 'result_count_bucket' THEN jsonb_typeof(e.value) = 'string'
                  AND (e.value #>> '{}') IN ('0', '1-5', '6-20', '21+')
                WHEN 'query_length_bucket' THEN jsonb_typeof(e.value) = 'string'
                  AND (e.value #>> '{}') IN ('0', '1-3', '4-10', '11-30', '31+')
                WHEN 'amount_bucket' THEN jsonb_typeof(e.value) = 'string'
                  AND (e.value #>> '{}') IN ('lt_1k', '1k_10k', '10k_1l', '1l_10l', '10l_1cr', '1cr_plus')
                WHEN 'method' THEN jsonb_typeof(e.value) = 'string'
                  AND (e.value #>> '{}') IN ('CARD', 'DELULUPAY_ID', 'NET_BANKING', 'BALANCE')
                WHEN 'item_count' THEN jsonb_typeof(e.value) = 'number'
                  AND (e.value #>> '{}') ~ '^[0-9]{1,3}$' AND (e.value #>> '{}')::int BETWEEN 1 AND 100
                ELSE false END)
$$;

-- ---------------------------------------------------------------- privileges
REVOKE ALL ON FUNCTION
  core.payment_display_status(text, boolean, boolean, boolean, boolean), core.my_payments(text, int),
  core.my_payment_attempt(uuid), core.my_bank_inbox(), core.checkout_payment_methods()
  FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;
GRANT EXECUTE ON FUNCTION core.my_payments(text, int), core.my_payment_attempt(uuid), core.my_bank_inbox(),
  core.checkout_payment_methods() TO app_web, app_pay;
