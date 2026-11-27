-- DeluluPay method configuration (PRD R4.2, R7 payments, R10 PaymentMethodConfig; US-35).
--
--  * core.payment_method_config is the VERSIONED per-method configuration: enabled, display order,
--    per-attempt and per-day limits in paise, an optional maintenance window. Rows are appended, never
--    changed or deleted; the current setting of a method is its highest version, and a method with no
--    row has the defaults (enabled, default order, no limit, no window). The application roles hold no
--    privilege on the table (owner-only row-level security); everything goes through the functions below.
--  * core.payment_method_gate(actor, method, total) is the ONE check a method must pass, read by
--    core.create_payment_attempt (0101) and by core.commit_purchase (0102), so a method turned off, in
--    maintenance, or over a limit cannot be used by calling the API directly. It refuses with
--    METHOD_UNAVAILABLE or METHOD_LIMIT_EXCEEDED, in the PRD's wording (R4.3: each decline says that no
--    fictional money moved). The per-day total is the actor's SUCCEEDED attempts of that method since
--    the start of the UTC day (LLD §1: "UTC day for ... quotas").
--  * The kill switches stay: payments_card and payments_netbanking (0013) gate CARD and NET_BANKING,
--    and payments_delulupay_id (new) gates DELULUPAY_ID. A method is available only when its switch is
--    on AND its configuration says enabled AND no maintenance window covers now.
--  * Changes go through the Super Admin's delayed queue (0090, decisions.md #16) as a NEW allow-listed
--    kind, 'payment_method.set': it waits admin_action_delay_seconds, is cancellable until it runs, and
--    its executor appends the next version. There is no faster path: no function other than the executor
--    writes the table. A change may not leave every method disabled (checked when proposed and again
--    when run), so the queue cannot be used to stop all payments.
--  * Tunables of the payment simulator (challenge and read limits) are configuration keys with defaults
--    and clamps, like the queue's (invariant 10): core.payment_setting(key).

-- ---------------------------------------------------------------- allow-lists and settings
CREATE FUNCTION core.payment_method_names() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['CARD', 'DELULUPAY_ID', 'NET_BANKING', 'BALANCE']
$$;

-- Default display order (PRD R4.2): the card is the default, the balance the fastest path.
CREATE FUNCTION core.payment_method_defaults() RETURNS TABLE (method text, display_order int)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT v.method, v.display_order
    FROM (VALUES ('CARD', 1), ('DELULUPAY_ID', 2), ('NET_BANKING', 3), ('BALANCE', 4)) AS v(method, display_order)
$$;

-- key, default, lowest, highest. Mirrors CHALLENGE_RULES in packages/core/src/pay (a database test
-- checks the two agree).
CREATE FUNCTION core.payment_setting_defaults() RETURNS TABLE (key text, dflt int, lo int, hi int)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.key, d.dflt, d.lo, d.hi
    FROM (VALUES ('challenge_ttl_seconds', 180, 30, 900),
                 ('challenge_tries', 3, 1, 10),
                 ('challenge_resend_seconds', 30, 5, 600),
                 ('challenge_codes_per_hour', 5, 1, 60),
                 ('challenge_slow_bank_seconds', 8, 1, 60),
                 ('payment_maintenance_max_hours', 336, 1, 2160),
                 ('payments_page_size', 20, 1, 50),
                 ('bank_inbox_max', 10, 1, 50)) AS d(key, dflt, lo, hi)
$$;

CREATE FUNCTION core.payment_setting(p_key text) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT GREATEST(d.lo, LEAST(core.config_int(core.current_config_id(), ARRAY[d.key], d.dflt), d.hi))::int
    FROM core.payment_setting_defaults() d
   WHERE d.key = p_key
$$;

CREATE FUNCTION core.payment_rules() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object(
    'ttlSeconds', (SELECT d.dflt FROM core.payment_setting_defaults() d WHERE d.key = 'challenge_ttl_seconds'),
    'tries', (SELECT d.dflt FROM core.payment_setting_defaults() d WHERE d.key = 'challenge_tries'),
    'resendSeconds', (SELECT d.dflt FROM core.payment_setting_defaults() d WHERE d.key = 'challenge_resend_seconds'),
    'codesPerHour', (SELECT d.dflt FROM core.payment_setting_defaults() d WHERE d.key = 'challenge_codes_per_hour'),
    'slowBankSeconds', (SELECT d.dflt FROM core.payment_setting_defaults() d WHERE d.key = 'challenge_slow_bank_seconds'))
$$;

-- The switch that gates a method; BALANCE has none (the configuration alone gates it).
CREATE FUNCTION core.payment_method_switch(p_method text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE p_method WHEN 'CARD' THEN 'payments_card'
                       WHEN 'NET_BANKING' THEN 'payments_netbanking'
                       WHEN 'DELULUPAY_ID' THEN 'payments_delulupay_id' END
$$;

INSERT INTO core.system_switch (name, enabled, updated_at)
VALUES ('payments_delulupay_id', true, now()) ON CONFLICT (name) DO NOTHING;

-- ---------------------------------------------------------------- the versioned configuration
CREATE TABLE core.payment_method_config (
  id                      uuid PRIMARY KEY,
  method                  text NOT NULL CHECK (method = ANY (core.payment_method_names())),
  version                 int  NOT NULL CHECK (version >= 1),
  enabled                 boolean NOT NULL,
  display_order           int  NOT NULL CHECK (display_order BETWEEN 1 AND 99),
  per_attempt_limit_paise bigint CHECK (per_attempt_limit_paise BETWEEN 1 AND 10000000000000),
  per_day_limit_paise     bigint CHECK (per_day_limit_paise BETWEEN 1 AND 10000000000000),
  maintenance_from        timestamptz,
  maintenance_until       timestamptz,
  action_id               uuid NOT NULL UNIQUE REFERENCES audit.pending_action (id),
  created_by              uuid NOT NULL,
  reason                  text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (method, version),
  CONSTRAINT payment_method_config_window CHECK (
    (maintenance_from IS NULL) = (maintenance_until IS NULL)
    AND (maintenance_from IS NULL OR maintenance_until > maintenance_from)),
  CONSTRAINT payment_method_config_limits CHECK (
    per_attempt_limit_paise IS NULL OR per_day_limit_paise IS NULL OR per_day_limit_paise >= per_attempt_limit_paise)
);
CREATE TRIGGER no_change BEFORE UPDATE OR DELETE ON core.payment_method_config
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON core.payment_method_config
  FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();
ALTER TABLE core.payment_method_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON core.payment_method_config USING (false) WITH CHECK (false);
REVOKE ALL ON core.payment_method_config FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;

-- ---------------------------------------------------------------- reads of the configuration
-- The current setting of every method (defaults where no version exists), with whether it can be used now.
CREATE FUNCTION core.payment_methods_now() RETURNS TABLE (
  method text, version int, enabled boolean, display_order int,
  per_attempt_limit_paise bigint, per_day_limit_paise bigint,
  maintenance_from timestamptz, maintenance_until timestamptz,
  in_maintenance boolean, switch_on boolean, available boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT x.method, x.version, x.enabled, x.display_order, x.per_attempt_limit_paise, x.per_day_limit_paise,
         x.maintenance_from, x.maintenance_until, x.in_maintenance, x.sw,
         x.enabled AND x.sw AND NOT x.in_maintenance
    FROM (SELECT d.method,
                 COALESCE(c.version, 0) AS version,
                 COALESCE(c.enabled, true) AS enabled,
                 COALESCE(c.display_order, d.display_order) AS display_order,
                 c.per_attempt_limit_paise, c.per_day_limit_paise, c.maintenance_from, c.maintenance_until,
                 COALESCE(c.maintenance_from <= clock_timestamp() AND c.maintenance_until > clock_timestamp(), false) AS in_maintenance,
                 COALESCE(core.switch_on(core.payment_method_switch(d.method)), false)
                   OR core.payment_method_switch(d.method) IS NULL AS sw
            FROM core.payment_method_defaults() d
            LEFT JOIN LATERAL (SELECT pc.* FROM core.payment_method_config pc
                                WHERE pc.method = d.method ORDER BY pc.version DESC LIMIT 1) c ON true) x
$$;

-- What the actor has paid with a method since the start of the UTC day.
CREATE FUNCTION core.payment_method_used_today(p_actor uuid, p_method text) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE(sum(cs.total_paise), 0)::bigint
    FROM core.payment_attempt pa JOIN core.checkout_session cs ON cs.id = pa.session_id
   WHERE pa.user_id = p_actor AND pa.method = p_method AND pa.state = 'SUCCEEDED'
     AND pa.created_at >= (date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
$$;

-- ---------------------------------------------------------------- the gate
-- Raises METHOD_UNAVAILABLE (off, switched off, in maintenance) or METHOD_LIMIT_EXCEEDED (the amount is
-- over the per-attempt limit, or with today's payments over the per-day limit). Never moves money.
CREATE FUNCTION core.payment_method_gate(p_actor uuid, p_method text, p_total bigint) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  m record;
BEGIN
  SELECT * INTO m FROM core.payment_methods_now() x WHERE x.method = p_method;
  IF NOT FOUND THEN
    PERFORM core.fail('METHOD_UNAVAILABLE', 'That payment method is not available. No fictional money moved.');
  END IF;
  IF m.in_maintenance THEN
    PERFORM core.fail('METHOD_UNAVAILABLE',
      'That payment method is in scheduled maintenance. Try another method. No fictional money moved.');
  ELSIF NOT m.enabled OR NOT m.switch_on THEN
    PERFORM core.fail('METHOD_UNAVAILABLE',
      'That payment method is switched off right now. Try another method. No fictional money moved.');
  END IF;
  IF m.per_attempt_limit_paise IS NOT NULL AND p_total > m.per_attempt_limit_paise THEN
    PERFORM core.fail('METHOD_LIMIT_EXCEEDED',
      'This amount is over the limit for that payment method. Try another method. No fictional money moved.');
  END IF;
  IF m.per_day_limit_paise IS NOT NULL
     AND core.payment_method_used_today(p_actor, p_method) + p_total > m.per_day_limit_paise THEN
    PERFORM core.fail('METHOD_LIMIT_EXCEEDED',
      'This would pass the daily limit for that payment method. Try another method. No fictional money moved.');
  END IF;
END $$;

-- ---------------------------------------------------------------- the delayed queue: a new kind
CREATE OR REPLACE FUNCTION core.admin_action_kinds() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['config.set', 'payment_method.set']
$$;

-- Canonical form of a maintenance bound: UTC, whole seconds.
CREATE FUNCTION core.payment_ts_text(p_value jsonb) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ts timestamptz;
BEGIN
  IF jsonb_typeof(p_value) <> 'string' OR (p_value #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:?[0-9]{2})$' THEN
    PERFORM core.fail('CONFIG_VALUE_INVALID', 'a maintenance time is an ISO date and time with a zone');
  END IF;
  BEGIN
    v_ts := (p_value #>> '{}')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    PERFORM core.fail('CONFIG_VALUE_INVALID', 'a maintenance time is an ISO date and time with a zone');
  END;
  RETURN to_char(date_trunc('second', v_ts) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
END $$;

-- Canonical payload of a payment_method.set action, or the refusal. Exactly the keys named below.
CREATE FUNCTION core.payment_method_set_validate(p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_method text;
  v_from   text;
  v_until  text;
  v_attempt bigint;
  v_day    bigint;
  v_order  int;
  v_keys   text[] := ARRAY['key', 'method', 'enabled', 'displayOrder', 'perAttemptLimitPaise', 'perDayLimitPaise',
                           'maintenanceFrom', 'maintenanceUntil'];
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k <> ALL (v_keys))
     OR EXISTS (SELECT 1 FROM unnest(v_keys) k WHERE NOT (p_payload ? k)) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'a payment method change names every setting of the method');
  END IF;
  IF jsonb_typeof(p_payload -> 'method') <> 'string' OR (p_payload ->> 'method') <> ALL (core.payment_method_names()) THEN
    PERFORM core.fail('CONFIG_KEY_UNKNOWN', 'that payment method does not exist');
  END IF;
  v_method := p_payload ->> 'method';
  IF p_payload ->> 'key' IS DISTINCT FROM 'payment_method.' || v_method THEN
    PERFORM core.fail('CONFIG_KEY_UNKNOWN', 'that setting cannot be changed here');
  END IF;
  IF jsonb_typeof(p_payload -> 'enabled') <> 'boolean' THEN
    PERFORM core.fail('CONFIG_VALUE_INVALID', 'enabled is true or false');
  END IF;
  IF jsonb_typeof(p_payload -> 'displayOrder') <> 'number' OR (p_payload ->> 'displayOrder') !~ '^[0-9]{1,2}$'
     OR (p_payload ->> 'displayOrder')::int NOT BETWEEN 1 AND 99 THEN
    PERFORM core.fail('CONFIG_VALUE_INVALID', 'the display order is a whole number from 1 to 99');
  END IF;
  v_order := (p_payload ->> 'displayOrder')::int;
  -- limits: paise as decimal strings, or null for none
  FOR i IN 1..2 LOOP
    DECLARE
      v_k text := CASE i WHEN 1 THEN 'perAttemptLimitPaise' ELSE 'perDayLimitPaise' END;
      v_v jsonb := p_payload -> v_k;
    BEGIN
      IF jsonb_typeof(v_v) <> 'null' AND (jsonb_typeof(v_v) <> 'string'
         OR (v_v #>> '{}') !~ '^[1-9][0-9]{0,13}$' OR (v_v #>> '{}')::bigint > 10000000000000) THEN
        PERFORM core.fail('CONFIG_VALUE_INVALID', 'a limit is a whole number of paise, as a string, or null for none');
      END IF;
      IF i = 1 THEN v_attempt := (v_v #>> '{}')::bigint; ELSE v_day := (v_v #>> '{}')::bigint; END IF;
    END;
  END LOOP;
  IF v_attempt IS NOT NULL AND v_day IS NOT NULL AND v_day < v_attempt THEN
    PERFORM core.fail('CONFIG_VALUE_INVALID', 'the daily limit cannot be below the per-payment limit');
  END IF;
  IF (jsonb_typeof(p_payload -> 'maintenanceFrom') = 'null') <> (jsonb_typeof(p_payload -> 'maintenanceUntil') = 'null') THEN
    PERFORM core.fail('CONFIG_VALUE_INVALID', 'a maintenance window has a start and an end');
  END IF;
  IF jsonb_typeof(p_payload -> 'maintenanceFrom') <> 'null' THEN
    v_from := core.payment_ts_text(p_payload -> 'maintenanceFrom');
    v_until := core.payment_ts_text(p_payload -> 'maintenanceUntil');
    IF v_until::timestamptz <= v_from::timestamptz
       OR v_until::timestamptz - v_from::timestamptz > make_interval(hours => core.payment_setting('payment_maintenance_max_hours')) THEN
      PERFORM core.fail('CONFIG_VALUE_INVALID', 'a maintenance window ends after it starts and is not longer than the maximum');
    END IF;
  END IF;
  RETURN jsonb_build_object(
    'key', 'payment_method.' || v_method, 'method', v_method, 'enabled', (p_payload ->> 'enabled')::boolean,
    'displayOrder', v_order,
    'perAttemptLimitPaise', CASE WHEN v_attempt IS NULL THEN 'null'::jsonb ELSE to_jsonb(v_attempt::text) END,
    'perDayLimitPaise', CASE WHEN v_day IS NULL THEN 'null'::jsonb ELSE to_jsonb(v_day::text) END,
    'maintenanceFrom', CASE WHEN v_from IS NULL THEN 'null'::jsonb ELSE to_jsonb(v_from) END,
    'maintenanceUntil', CASE WHEN v_until IS NULL THEN 'null'::jsonb ELSE to_jsonb(v_until) END);
END $$;

-- Would at least one method stay enabled (configuration and switch) if p_method were set to p_enabled?
CREATE FUNCTION core.payment_one_method_stays(p_method text, p_enabled boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM core.payment_methods_now() m
                  WHERE m.method <> p_method AND m.enabled AND m.switch_on)
      OR (p_enabled AND EXISTS (SELECT 1 FROM core.payment_methods_now() m WHERE m.method = p_method AND m.switch_on))
$$;

-- Is the payload exactly the method's current setting? (a no-op change)
CREATE FUNCTION core.payment_method_unchanged(p_payload jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE((m.enabled, m.display_order, m.per_attempt_limit_paise, m.per_day_limit_paise,
                   m.maintenance_from, m.maintenance_until)
                  IS NOT DISTINCT FROM
                  ((p_payload ->> 'enabled')::boolean, (p_payload ->> 'displayOrder')::int,
                   (p_payload ->> 'perAttemptLimitPaise')::bigint, (p_payload ->> 'perDayLimitPaise')::bigint,
                   (p_payload ->> 'maintenanceFrom')::timestamptz, (p_payload ->> 'maintenanceUntil')::timestamptz), false)
    FROM core.payment_methods_now() m WHERE m.method = p_payload ->> 'method'
$$;

CREATE OR REPLACE FUNCTION core.admin_action_validate(p_kind text, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_key   text;
  v_value text;
  v_reg   record;
BEGIN
  IF p_kind IS NULL OR p_kind <> ALL (core.admin_action_kinds()) THEN
    PERFORM core.fail('ADMIN_ACTION_UNKNOWN', 'that kind of action is not allowed');
  END IF;
  IF p_kind = 'payment_method.set' THEN
    RETURN core.payment_method_set_validate(p_payload);
  END IF;
  -- config.set: exactly {key, value}, both strings
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('key', 'value'))
     OR NOT (p_payload ? 'key') OR NOT (p_payload ? 'value') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'a configuration change names a key and a value');
  END IF;
  IF jsonb_typeof(p_payload -> 'key') <> 'string' THEN
    PERFORM core.fail('CONFIG_KEY_UNKNOWN', 'that setting cannot be changed here');
  END IF;
  v_key := p_payload ->> 'key';
  SELECT * INTO v_reg FROM core.config_key_registry() r WHERE r.key = v_key;
  IF NOT FOUND THEN
    PERFORM core.fail('CONFIG_KEY_UNKNOWN', 'that setting cannot be changed here');
  END IF;
  IF jsonb_typeof(p_payload -> 'value') <> 'string' THEN
    PERFORM core.fail('CONFIG_VALUE_INVALID', 'the value is a whole number written as a string');
  END IF;
  v_value := p_payload ->> 'value';
  IF v_value !~ '^(0|[1-9][0-9]{0,14})$' OR v_value::bigint < v_reg.min_value OR v_value::bigint > v_reg.max_value THEN
    PERFORM core.fail('CONFIG_VALUE_INVALID', format('the value must be a whole number from %s to %s', v_reg.min_value, v_reg.max_value));
  END IF;
  RETURN jsonb_build_object('key', v_key, 'value', v_value);
END $$;

-- The console's view of one action (0090) plus, for a payment method change, the new settings.
CREATE OR REPLACE FUNCTION core.admin_action_json(a audit.pending_action) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', a.id,
    'kind', a.action,
    'key', a.payload ->> 'key',
    'value', a.payload ->> 'value',
    'reason', a.reason,
    'state', a.state,
    'proposedAt', a.proposed_at,
    'notBefore', a.not_before,
    'secondsLeft', CASE WHEN a.state = 'QUEUED'
                        THEN GREATEST(0, ceil(extract(epoch FROM a.not_before - clock_timestamp())))::int END,
    'executedAt', a.executed_at,
    'cancelledAt', a.cancelled_at,
    'cancelReason', a.cancel_reason,
    'outcome', CASE WHEN a.outcome IS NULL THEN NULL
                    ELSE jsonb_strip_nulls(jsonb_build_object('code', a.outcome -> 'code', 'changed', a.outcome -> 'changed',
                                                              'configVersion', a.outcome -> 'configVersion')) END,
    'canCancel', a.state = 'QUEUED')
    || CASE WHEN a.action = 'payment_method.set' THEN jsonb_build_object('details', a.payload - 'key') ELSE '{}'::jsonb END
$$;

-- propose (0090) with the second kind: one waiting change per key, and a change equal to the current
-- setting is a conflict.
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
    IF NOT core.payment_one_method_stays(v_payload ->> 'method', (v_payload ->> 'enabled')::boolean) THEN
      PERFORM core.fail('CONFIG_VALUE_INVALID', 'at least one payment method must stay enabled');
    END IF;
  END IF;
  v_when := clock_timestamp() + make_interval(secs => core.admin_action_setting('admin_action_delay_seconds'));
  INSERT INTO audit.pending_action (id, action, payload, payload_hash, requested_by, not_before, reason)
  VALUES (v_id, p_kind, v_payload, sha256(convert_to(v_payload::text, 'UTF8')), v_actor, v_when, v_reason)
  RETURNING * INTO v_row;
  PERFORM core.admin_audit(v_actor, 'admin_action.propose', 'admin_action', v_id::text, v_reason,
                           jsonb_build_object('kind', p_kind, 'key', v_payload ->> 'key', 'value', v_payload ->> 'value',
                                              'notBefore', v_when));
  PERFORM core.admin_action_notify('admin_action_proposed', v_id, p_kind, v_payload ->> 'key', v_when);
  RETURN core.admin_action_json(v_row);
END $$;

-- ---------------------------------------------------------------- execute
-- Appends the next version of a method's configuration. Returns {changed, configVersion} (the method's
-- version number) or raises a coded refusal.
CREATE FUNCTION core.admin_action_apply_payment_method_set(p_action uuid, p_payload jsonb, p_requested_by uuid, p_reason text)
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
  IF NOT core.payment_one_method_stays(v_method, (p_payload ->> 'enabled')::boolean) THEN
    PERFORM core.fail('CONFIG_VALUE_INVALID', 'at least one payment method must stay enabled');
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
                       'enabled', (p_payload ->> 'enabled')::boolean, 'requestedBy', p_requested_by));
  RETURN jsonb_build_object('changed', true, 'configVersion', v_version);
END $$;

CREATE OR REPLACE FUNCTION core.admin_action_run(a audit.pending_action) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_payload jsonb;
BEGIN
  IF a.payload_hash IS DISTINCT FROM sha256(convert_to(a.payload::text, 'UTF8')) THEN
    PERFORM core.fail('PAYLOAD_TAMPERED', 'the stored request does not match its hash');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.user_profile up
                  WHERE up.id = a.requested_by AND up.role = 'SUPER_ADMIN' AND up.status = 'ACTIVE') THEN
    PERFORM core.fail('REQUESTER_NOT_ADMIN', 'the person who asked is no longer the Super Admin');
  END IF;
  v_payload := core.admin_action_validate(a.action, a.payload);
  IF a.action = 'config.set' THEN
    RETURN core.admin_action_apply_config_set(a.id, v_payload, a.requested_by, COALESCE(a.reason, ''));
  ELSIF a.action = 'payment_method.set' THEN
    RETURN core.admin_action_apply_payment_method_set(a.id, v_payload, a.requested_by, COALESCE(a.reason, ''));
  END IF;
  PERFORM core.fail('ADMIN_ACTION_UNKNOWN', 'that kind of action is not allowed');
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------- the console's read
CREATE FUNCTION core.admin_payment_methods() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := core.admin_actor();
BEGIN
  RETURN jsonb_build_object(
    'serverNow', clock_timestamp(),
    'delaySeconds', core.admin_action_setting('admin_action_delay_seconds'),
    'methods', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'method', m.method, 'version', m.version, 'enabled', m.enabled, 'switchOn', m.switch_on,
        'displayOrder', m.display_order,
        'perAttemptLimitPaise', m.per_attempt_limit_paise::text, 'perDayLimitPaise', m.per_day_limit_paise::text,
        'maintenanceFrom', m.maintenance_from, 'maintenanceUntil', m.maintenance_until,
        'inMaintenance', m.in_maintenance, 'available', m.available,
        'pendingActionId', (SELECT a.id FROM audit.pending_action a
                             WHERE a.state = 'QUEUED' AND a.action = 'payment_method.set'
                               AND a.payload ->> 'key' = 'payment_method.' || m.method
                             ORDER BY a.not_before LIMIT 1)) ORDER BY m.display_order, m.method), '[]'::jsonb)
                  FROM core.payment_methods_now() m));
END $$;

-- ---------------------------------------------------------------- privileges
REVOKE ALL ON FUNCTION
  core.payment_method_names(), core.payment_method_defaults(), core.payment_setting_defaults(),
  core.payment_setting(text), core.payment_rules(), core.payment_method_switch(text),
  core.payment_methods_now(), core.payment_method_used_today(uuid, text), core.payment_method_gate(uuid, text, bigint),
  core.payment_ts_text(jsonb), core.payment_method_set_validate(jsonb), core.payment_method_unchanged(jsonb), core.payment_one_method_stays(text, boolean),
  core.admin_action_apply_payment_method_set(uuid, jsonb, uuid, text), core.admin_payment_methods()
  FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;
GRANT EXECUTE ON FUNCTION core.admin_payment_methods() TO app_web;
