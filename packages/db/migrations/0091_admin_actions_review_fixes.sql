-- Review fixes for 0090 (docs/decisions.md #16).
--  * core.admin_action_apply_config_set read the clock for the new version's effective_from BEFORE
--    waiting for the base version's lock and reused it after the wait, so an executor that waited
--    could (a) not see a version written meanwhile, because its stale clock excluded it, and so drop
--    that change, and (b) stamp an effective_from earlier than its base's. The clock is now read after
--    the lock, the base is re-chosen with that reading, and effective_from is never below the base's.
--  * core.announcement was not append-only; it now refuses update, delete and truncate like the change it announces.

CREATE OR REPLACE FUNCTION core.admin_action_apply_config_set(p_action uuid, p_payload jsonb, p_requested_by uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_key    text := p_payload ->> 'key';
  v_new    bigint := (p_payload ->> 'value')::bigint;
  v_reg    record;
  v_grace  int := core.admin_action_setting('config_apply_grace_seconds');
  v_eff    timestamptz;
  v_base_eff timestamptz;
  v_base   int;
  v_tries  int := 0;
  v_vals   jsonb;
  v_old    bigint;
  v_stored jsonb;
  v_id     int;
  v_change uuid := core.uuid_v7();
BEGIN
  SELECT * INTO v_reg FROM core.config_key_registry() r WHERE r.key = v_key;
  IF NOT FOUND THEN
    PERFORM core.fail('CONFIG_KEY_UNKNOWN', 'that setting cannot be changed here');
  END IF;
  LOOP
    v_tries := v_tries + 1;
    SELECT max(cv.id) INTO v_base FROM core.config_version cv
     WHERE cv.effective_from <= clock_timestamp() + make_interval(secs => v_grace);
    PERFORM 1 FROM core.config_version cv WHERE cv.id = v_base FOR NO KEY UPDATE;
    -- the clock is read AFTER the lock wait: a version written meanwhile was stamped by a clock that
    -- is earlier than this one, so the new version's effective_from never falls behind its base
    v_eff := clock_timestamp() + make_interval(secs => v_grace);
    EXIT WHEN v_base = (SELECT max(cv.id) FROM core.config_version cv WHERE cv.effective_from <= v_eff);
    IF v_tries >= 10 THEN
      PERFORM core.fail('BUSY', 'configuration is busy');
    END IF;
  END LOOP;
  SELECT cv.values, cv.effective_from INTO v_vals, v_base_eff FROM core.config_version cv WHERE cv.id = v_base;
  v_eff := GREATEST(v_eff, v_base_eff);
  v_old := CASE v_reg.kind WHEN 'paise' THEN core.config_paise(v_base, v_reg.path, v_reg.default_value)
                           ELSE core.config_int(v_base, v_reg.path, v_reg.default_value) END;
  IF v_old = v_new THEN
    RETURN jsonb_build_object('changed', false, 'configVersion', v_base);   -- already the value: no new version
  END IF;
  v_stored := CASE v_reg.kind WHEN 'paise' THEN to_jsonb(v_new::text) ELSE to_jsonb(v_new) END;
  IF cardinality(v_reg.path) = 2 AND jsonb_typeof(v_vals #> ARRAY[v_reg.path[1]]) IS DISTINCT FROM 'object' THEN
    v_vals := jsonb_set(v_vals, ARRAY[v_reg.path[1]], '{}'::jsonb, true);
  END IF;
  -- the note is readable by application roles: the key only, never the reason
  INSERT INTO core.config_version (values, effective_from, created_by, note)
  VALUES (jsonb_set(v_vals, v_reg.path, v_stored, true), v_eff, p_requested_by, 'console change: ' || v_key)
  RETURNING id INTO v_id;
  INSERT INTO audit.config_change (id, action_id, area, key, old_value, new_value, previous_version, new_version,
                                   actor_id, approver, reason)
  VALUES (v_change, p_action, 'ECONOMY', v_key, v_old::text, v_new::text, v_base, v_id, p_requested_by,
          'DELAYED_EXECUTION', p_reason);
  INSERT INTO core.announcement (id, change_id, key, new_value, effective_from)
  VALUES (core.uuid_v7(), v_change, v_key, v_new::text, v_eff);
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
    jsonb_build_object('kind', 'config.set', 'key', v_key, 'oldValue', v_old::text, 'newValue', v_new::text,
                       'configVersion', v_id, 'previousVersion', v_base, 'requestedBy', p_requested_by,
                       'changeId', v_change));
  RETURN jsonb_build_object('changed', true, 'configVersion', v_id);
END $$;

-- ---------------------------------------------------------------- announcements are immutable
CREATE TRIGGER no_change BEFORE UPDATE OR DELETE ON core.announcement
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON core.announcement
  FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();
