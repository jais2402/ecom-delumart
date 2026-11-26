-- Queue safety for payment method changes (second review of 0104; decisions.md #17). 0100-0104 are not edited.
--
--  * core.payment_end_state_usable (0104) checked a change that sets no window only at this instant, so other
--    methods' FUTURE windows were ignored and a sequence of single disables could leave no usable method during
--    a window set earlier. It now builds the END STATE (current configuration with the payload applied) and
--    requires, at now and at every future boundary instant (each method's maintenance_from and maintenance_until
--    that is not in the past), that SOME method is enabled, switched on, has limits at or above the floors and
--    is not inside its window [from, until). Between two boundaries the state does not change, so these instants
--    are enough. Every change is checked this way, with or without a window.
--  * Concurrent runs of core.admin_actions_execute_due each take a different due action (SKIP LOCKED) and, under
--    READ COMMITTED, each saw the other method still enabled. core.admin_action_apply_payment_method_set and the
--    payment_method.set branch of core.admin_action_propose now take ONE global transaction-level advisory lock
--    as their first statement and read the configuration after it, so the second waits and re-checks (a wait
--    longer than the function's lock_timeout leaves the action QUEUED for the next run, as in 0090).

CREATE OR REPLACE FUNCTION core.payment_end_state_usable(p_payload jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_method text := p_payload ->> 'method';
  v_now    timestamptz := clock_timestamp();
BEGIN
  RETURN NOT EXISTS (
    WITH floors AS (SELECT * FROM core.payment_limit_floors()),
    st AS (
      SELECT m.method, m.switch_on,
             CASE WHEN m.method = v_method THEN (p_payload ->> 'enabled')::boolean ELSE m.enabled END AS enabled,
             CASE WHEN m.method = v_method THEN (p_payload ->> 'perAttemptLimitPaise')::bigint ELSE m.per_attempt_limit_paise END AS per_attempt,
             CASE WHEN m.method = v_method THEN (p_payload ->> 'perDayLimitPaise')::bigint ELSE m.per_day_limit_paise END AS per_day,
             CASE WHEN m.method = v_method THEN (p_payload ->> 'maintenanceFrom')::timestamptz ELSE m.maintenance_from END AS mf,
             CASE WHEN m.method = v_method THEN (p_payload ->> 'maintenanceUntil')::timestamptz ELSE m.maintenance_until END AS mu
        FROM core.payment_methods_now() m),
    instants AS (
      SELECT v_now AS t
      UNION SELECT s.mf FROM st s WHERE s.mf >= v_now
      UNION SELECT s.mu FROM st s WHERE s.mu >= v_now)
    SELECT 1 FROM instants i
     WHERE NOT EXISTS (
       SELECT 1 FROM st s, floors f
        WHERE s.enabled AND s.switch_on
          AND (s.per_attempt IS NULL OR s.per_attempt >= f.per_attempt)
          AND (s.per_day IS NULL OR s.per_day >= f.per_day)
          AND (s.mf IS NULL OR NOT (s.mf <= i.t AND i.t < s.mu))));
END $$;

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
  -- one writer of payment method configuration at a time, before anything is read (also taken by the executor)
  IF p_kind = 'payment_method.set' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('core.payment_method_config', 0));
  END IF;
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
  -- ONE writer of payment method configuration at a time, whatever the method: the first statement, so the
  -- state read below is read after any concurrent change committed (READ COMMITTED re-reads per statement)
  PERFORM pg_advisory_xact_lock(hashtextextended('core.payment_method_config', 0));
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
