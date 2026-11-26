-- The Super Admin's 24-hour delayed, cancellable execution queue (PRD R16.6, US-60) and versioned
-- configuration changes (R7 Settings and Economy, R10 ConsoleConfigChange; docs/decisions.md #15).
--
--  * audit.pending_action (0008) becomes the queue. A Super Admin PROPOSES an action of an
--    allow-listed kind with a reason (core.admin_action_propose); it waits `admin_action_delay_seconds`
--    (24 h, clamped to 1 h .. 7 days) and can be CANCELLED until it has run (core.admin_action_cancel);
--    the jobs role runs the due ones through core.admin_actions_execute_due(), exactly once.
--    Application roles hold NO direct privilege on the table any more (the grants of 0011 are
--    revoked; there was no function behind them); every read and write goes through the definer
--    functions below. A finished action never changes and none is ever deleted (trigger).
--  * Action kinds are an allow-list in core.admin_action_kinds(): only 'config.set' in this release.
--    To add one: extend the list, extend core.admin_action_validate and core.admin_action_run in a
--    new migration, and add the executor function. Proposal and execution both validate, so a row
--    planted past the proposal checks fails safely (FAILED with a code, nothing applied).
--  * 'config.set' changes ONE allow-listed configuration key (core.config_key_registry(), bounds per
--    key: a fee is never below 0 and never above its ceiling, so a bad value cannot break checkout).
--    Executing it writes a NEW core.config_version (the base version's values plus the change; an
--    old version is never updated), effective `config_apply_grace_seconds` (30) later so that no
--    checkout session opened while the executing transaction is still uncommitted can be priced
--    under the old version yet start after the new one (the pay check of 0016 compares the two).
--    Orders keep the version they were placed under (core.order_group.config_version, unchanged).
--    The change is recorded in audit.config_change (the ConsoleConfigChange of R10: area, before and
--    after, version, actor, approver, reason), in the audit log, in a public announcement
--    (core.announcement, read through core.public_announcements, no reason and no person), and as a
--    console_config_changed analytics event written by the database (no user id, no props).
--  * Locks (LLD §4 does not list these; they are taken in this order and by no other transaction
--    that holds a money lock): the actor's advisory proposal lock (propose only), then the
--    pending_action rows (FOR UPDATE; the executor SKIPS LOCKED, ascending not_before and id), then
--    the base configuration version (FOR NO KEY UPDATE, which does not conflict with the foreign-key
--    share locks of journals, so purchases never wait for it), then the audit chain head.
--  * Notifications: each step writes an audit.outbox row (ids, kind, key and times; no person and no
--    reason). There is no email sender in the app yet. TODO(email-sender): the outbox relay turns
--    admin_action_proposed, admin_action_cancelled, admin_action_executed and admin_action_failed
--    into the alert email to the Super Admin (R16.6).
--  * app_jobs stays least-privilege: it gains EXECUTE on core.admin_actions_execute_due(int) only.
--  * analytics: console_config_changed joins the allow-lists as a DATABASE-ONLY server event: only
--    the executor writes it; analytics.record_event refuses it from any caller.

-- ---------------------------------------------------------------- the allow-lists and settings
CREATE FUNCTION core.admin_action_kinds() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['config.set']
$$;

-- Configuration keys the Super Admin may change through the queue. Mirrors CONFIG_KEYS in
-- packages/core/src/console-config (a database test checks they agree). Defaults mirror 0016.
CREATE FUNCTION core.config_key_registry()
RETURNS TABLE (key text, path text[], kind text, min_value bigint, max_value bigint, default_value bigint, ord int)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT v.key, v.path, v.kind, v.min_value, v.max_value, v.default_value, v.ord
    FROM (VALUES
      ('fee_percent',                ARRAY['fee_percent'],                    'percent', 0::bigint, 20::bigint,       5::bigint,       1),
      ('delivery_fee_paise.STANDARD', ARRAY['delivery_fee_paise', 'STANDARD'], 'paise',   0::bigint, 10000000::bigint, 100000::bigint,  2),
      ('delivery_fee_paise.EXPRESS',  ARRAY['delivery_fee_paise', 'EXPRESS'],  'paise',   0::bigint, 10000000::bigint, 1000000::bigint, 3),
      ('delivery_fee_paise.ZAP',      ARRAY['delivery_fee_paise', 'ZAP'],      'paise',   0::bigint, 10000000::bigint, 5000000::bigint, 4)
    ) AS v(key, path, kind, min_value, max_value, default_value, ord)
$$;

-- Tunables of the queue, each a configuration key with a default and a clamp (invariant 10).
CREATE FUNCTION core.admin_action_setting_defaults()
RETURNS TABLE (key text, dflt int, lo int, hi int)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.key, d.dflt, d.lo, d.hi
    FROM (VALUES ('admin_action_delay_seconds', 86400, 3600, 604800),
                 ('admin_action_open_max', 20, 1, 100),
                 ('config_apply_grace_seconds', 30, 0, 300),
                 ('announcement_window_hours', 72, 1, 720),
                 ('announcement_max', 3, 1, 10),
                 ('admin_action_page_size', 50, 1, 100)) AS d(key, dflt, lo, hi)
$$;

CREATE FUNCTION core.admin_action_setting(p_key text) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT GREATEST(d.lo, LEAST(core.config_int(core.current_config_id(), ARRAY[d.key], d.dflt), d.hi))::int
    FROM core.admin_action_setting_defaults() d
   WHERE d.key = p_key
$$;

-- The defaults and limits as the TypeScript module names them (ADMIN_ACTION_RULES); for a drift test.
CREATE FUNCTION core.admin_action_rules() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object(
    'delaySeconds', (SELECT d.dflt FROM core.admin_action_setting_defaults() d WHERE d.key = 'admin_action_delay_seconds'),
    'delayMinSeconds', (SELECT d.lo FROM core.admin_action_setting_defaults() d WHERE d.key = 'admin_action_delay_seconds'),
    'delayMaxSeconds', (SELECT d.hi FROM core.admin_action_setting_defaults() d WHERE d.key = 'admin_action_delay_seconds'),
    'openMax', (SELECT d.dflt FROM core.admin_action_setting_defaults() d WHERE d.key = 'admin_action_open_max'),
    'applyGraceSeconds', (SELECT d.dflt FROM core.admin_action_setting_defaults() d WHERE d.key = 'config_apply_grace_seconds'),
    'announcementWindowHours', (SELECT d.dflt FROM core.admin_action_setting_defaults() d WHERE d.key = 'announcement_window_hours'),
    'announcementMax', (SELECT d.dflt FROM core.admin_action_setting_defaults() d WHERE d.key = 'announcement_max'),
    'pageSize', (SELECT d.dflt FROM core.admin_action_setting_defaults() d WHERE d.key = 'admin_action_page_size'))
$$;

-- ---------------------------------------------------------------- tables
ALTER TABLE audit.pending_action
  ADD COLUMN reason        text,
  ADD COLUMN proposed_at   timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN cancelled_at  timestamptz,
  ADD COLUMN cancel_reason text,
  ADD COLUMN outcome       jsonb,
  ADD CONSTRAINT pending_action_cancel_coherent CHECK ((state = 'CANCELLED') = (cancelled_at IS NOT NULL)),
  ADD CONSTRAINT pending_action_done_coherent CHECK ((state IN ('EXECUTED', 'FAILED')) = (executed_at IS NOT NULL)),
  ADD CONSTRAINT pending_action_outcome_coherent CHECK ((state IN ('EXECUTED', 'FAILED')) = (outcome IS NOT NULL));
CREATE INDEX pending_action_due ON audit.pending_action (not_before, id) WHERE state = 'QUEUED';
CREATE INDEX pending_action_proposed ON audit.pending_action (proposed_at DESC, id DESC);

-- A queued action's request never changes (only its state moves, and only forward from QUEUED); a
-- finished one never changes; none is deleted. not_before is left movable for the database OWNER only
-- (the local test helper that shortens the delay is an owner connection; no application role can write).
CREATE FUNCTION audit.guard_pending_action() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'pending actions are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.state <> 'QUEUED' THEN
    RAISE EXCEPTION 'a finished action never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.action, NEW.payload, NEW.payload_hash, NEW.requested_by, NEW.reason, NEW.proposed_at)
     IS DISTINCT FROM (OLD.id, OLD.action, OLD.payload, OLD.payload_hash, OLD.requested_by, OLD.reason, OLD.proposed_at) THEN
    RAISE EXCEPTION 'a queued action''s request never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pending_action_guard BEFORE UPDATE OR DELETE ON audit.pending_action
  FOR EACH ROW EXECUTE FUNCTION audit.guard_pending_action();
CREATE TRIGGER pending_action_no_truncate BEFORE TRUNCATE ON audit.pending_action
  FOR EACH STATEMENT EXECUTE FUNCTION audit.guard_pending_action();

-- ConsoleConfigChange (PRD R10): one row per configuration version a delayed action created.
CREATE TABLE audit.config_change (
  id               uuid PRIMARY KEY,
  action_id        uuid NOT NULL UNIQUE REFERENCES audit.pending_action (id),
  area             text NOT NULL CHECK (area IN ('ECONOMY')),
  key              text NOT NULL,
  old_value        text NOT NULL,
  new_value        text NOT NULL,
  previous_version int  NOT NULL REFERENCES core.config_version (id),
  new_version      int  NOT NULL UNIQUE REFERENCES core.config_version (id),
  actor_id         uuid NOT NULL,
  approver         text NOT NULL CHECK (approver IN ('DELAYED_EXECUTION')),
  reason           text NOT NULL,
  changed_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER no_change BEFORE UPDATE OR DELETE ON audit.config_change
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON audit.config_change
  FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();

-- The public, in-app announcement of an executed economy change: the setting and the new value only.
CREATE TABLE core.announcement (
  id             uuid PRIMARY KEY,
  change_id      uuid NOT NULL UNIQUE REFERENCES audit.config_change (id),
  key            text NOT NULL,
  new_value      text NOT NULL CHECK (new_value ~ '^[0-9]{1,18}$'),
  effective_from timestamptz NOT NULL,
  announced_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX announcement_recent ON core.announcement (announced_at DESC, id DESC);

-- ---------------------------------------------------------------- privileges and row-level security
DROP POLICY web_super_admin ON audit.pending_action;
ALTER TABLE audit.config_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.announcement   ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON audit.pending_action USING (false) WITH CHECK (false);
CREATE POLICY owner_only ON audit.config_change  USING (false) WITH CHECK (false);
CREATE POLICY owner_only ON core.announcement    USING (false) WITH CHECK (false);
REVOKE ALL ON audit.pending_action, audit.config_change, core.announcement
  FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;

-- ---------------------------------------------------------------- helpers
-- Canonical payload of an action of a kind, or the refusal: ADMIN_ACTION_UNKNOWN, CONFIG_KEY_UNKNOWN,
-- CONFIG_VALUE_INVALID, VALIDATION_FAILED. Used when proposing and again when running.
CREATE FUNCTION core.admin_action_validate(p_kind text, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_key   text;
  v_value text;
  v_reg   record;
BEGIN
  IF p_kind IS NULL OR p_kind <> ALL (core.admin_action_kinds()) THEN
    PERFORM core.fail('ADMIN_ACTION_UNKNOWN', 'that kind of action is not allowed');
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

-- The queue's outbox record. TODO(email-sender): the relay turns these into the alert email (R16.6).
CREATE FUNCTION core.admin_action_notify(p_type text, p_id uuid, p_kind text, p_key text, p_not_before timestamptz)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- ids, the kind, the key and a time only: no person, no reason, no value (invariant 8)
  INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
  VALUES (core.uuid_v7(), p_type, p_id,
          jsonb_strip_nulls(jsonb_build_object('actionId', p_id, 'kind', p_kind, 'key', p_key,
                                               'notBefore', p_not_before)), 1);
END $$;

-- The console's view of one action. Names no user and shows only the safe parts of an outcome.
CREATE FUNCTION core.admin_action_json(a audit.pending_action) RETURNS jsonb
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
$$;

-- The newest configuration version that is, or will be within the grace period, effective: the one a
-- new version is built on, and the one a proposal is compared with.
CREATE FUNCTION core.admin_config_base_id() RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT max(cv.id) FROM core.config_version cv
   WHERE cv.effective_from <= clock_timestamp() + make_interval(secs => core.admin_action_setting('config_apply_grace_seconds'))
$$;

-- ---------------------------------------------------------------- propose
CREATE FUNCTION core.admin_action_propose(p_kind text, p_payload jsonb, p_reason text) RETURNS jsonb
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
  IF p_kind = 'config.set' THEN
    IF EXISTS (SELECT 1 FROM audit.pending_action a
                WHERE a.state = 'QUEUED' AND a.action = 'config.set' AND a.payload ->> 'key' = v_payload ->> 'key') THEN
      PERFORM core.fail('CONFLICT', 'a change to this setting is already waiting');
    END IF;
    SELECT * INTO v_reg FROM core.config_key_registry() r WHERE r.key = v_payload ->> 'key';
    v_base := core.admin_config_base_id();
    v_current := CASE v_reg.kind WHEN 'paise' THEN core.config_paise(v_base, v_reg.path, v_reg.default_value)
                                 ELSE core.config_int(v_base, v_reg.path, v_reg.default_value) END;
    IF v_current = (v_payload ->> 'value')::bigint THEN
      PERFORM core.fail('CONFLICT', 'that is already the value');
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

-- ---------------------------------------------------------------- cancel
-- Cancelling only ever removes a change, so it does not need a recent sign-in (decisions.md #15).
CREATE FUNCTION core.admin_action_cancel(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_actor  uuid := core.admin_actor();
  v_reason text := core.admin_reason(p_reason);
  v_a      audit.pending_action;
BEGIN
  SELECT * INTO v_a FROM audit.pending_action a WHERE a.id = p_id FOR UPDATE;   -- waits for a running executor
  IF NOT FOUND THEN
    PERFORM core.fail('NOT_FOUND', 'no such action');
  END IF;
  IF v_a.state <> 'QUEUED' THEN
    PERFORM core.fail('CONFLICT', 'this action is no longer waiting');
  END IF;
  UPDATE audit.pending_action a
     SET state = 'CANCELLED', cancelled_at = clock_timestamp(), cancel_reason = v_reason
   WHERE a.id = v_a.id
  RETURNING * INTO v_a;
  PERFORM core.admin_audit(v_actor, 'admin_action.cancel', 'admin_action', v_a.id::text, v_reason,
                           jsonb_build_object('kind', v_a.action, 'key', v_a.payload ->> 'key'));
  PERFORM core.admin_action_notify('admin_action_cancelled', v_a.id, v_a.action, v_a.payload ->> 'key', v_a.not_before);
  RETURN core.admin_action_json(v_a);
END $$;

-- ---------------------------------------------------------------- reads (Super Admin only)
CREATE FUNCTION core.admin_actions(p_scope text, p_page int) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := core.admin_actor();
  v_size  int := core.admin_action_setting('admin_action_page_size');
  v_page  int := GREATEST(COALESCE(p_page, 1), 1);
  v_total bigint;
  v_items jsonb;
BEGIN
  IF p_scope IS NULL OR p_scope NOT IN ('OPEN', 'HISTORY', 'ALL') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'scope is OPEN, HISTORY or ALL');
  END IF;
  SELECT count(*) INTO v_total FROM audit.pending_action a
   WHERE p_scope = 'ALL' OR (p_scope = 'OPEN') = (a.state = 'QUEUED');
  -- OPEN: soonest first; HISTORY and ALL: newest proposal first
  SELECT COALESCE(jsonb_agg(x.j ORDER BY x.k1, x.proposed_at DESC, x.id DESC), '[]'::jsonb)
    INTO v_items
    FROM (SELECT core.admin_action_json(a) AS j, a.proposed_at, a.id,
                 CASE WHEN p_scope = 'OPEN' THEN a.not_before END AS k1
            FROM audit.pending_action a
           WHERE p_scope = 'ALL' OR (p_scope = 'OPEN') = (a.state = 'QUEUED')
           ORDER BY CASE WHEN p_scope = 'OPEN' THEN a.not_before END, a.proposed_at DESC, a.id DESC
           LIMIT v_size OFFSET (v_page - 1) * v_size) x;
  RETURN jsonb_build_object('items', v_items, 'page', v_page, 'pageSize', v_size, 'total', v_total,
                            'totalPages', GREATEST(1, ceil(v_total::numeric / v_size))::int,
                            'serverNow', clock_timestamp());
END $$;

CREATE FUNCTION core.admin_config_overview() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := core.admin_actor();
  v_cfg   int := core.current_config_id();
BEGIN
  RETURN jsonb_build_object(
    'version', v_cfg,
    'effectiveFrom', (SELECT cv.effective_from FROM core.config_version cv WHERE cv.id = v_cfg),
    'delaySeconds', core.admin_action_setting('admin_action_delay_seconds'),
    'serverNow', clock_timestamp(),
    'keys', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'key', r.key, 'kind', r.kind,
                'min', r.min_value::text, 'max', r.max_value::text, 'default', r.default_value::text,
                'current', (CASE r.kind WHEN 'paise' THEN core.config_paise(v_cfg, r.path, r.default_value)
                                        ELSE core.config_int(v_cfg, r.path, r.default_value) END)::text,
                'pendingActionId', (SELECT a.id FROM audit.pending_action a
                                     WHERE a.state = 'QUEUED' AND a.action = 'config.set' AND a.payload ->> 'key' = r.key
                                     ORDER BY a.not_before LIMIT 1)) ORDER BY r.ord), '[]'::jsonb)
               FROM core.config_key_registry() r));
END $$;

-- Public: the economy changes announced within the window, newest first. No reason, no person, no old value.
CREATE FUNCTION core.public_announcements() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', x.id, 'key', x.key, 'value', x.new_value,
                                               'effectiveFrom', x.effective_from, 'announcedAt', x.announced_at)
                            ORDER BY x.announced_at DESC, x.id DESC), '[]'::jsonb)
    FROM (SELECT n.* FROM core.announcement n
           WHERE n.announced_at > clock_timestamp() - make_interval(hours => core.admin_action_setting('announcement_window_hours'))
           ORDER BY n.announced_at DESC, n.id DESC
           LIMIT core.admin_action_setting('announcement_max')) x
$$;

-- ---------------------------------------------------------------- execute
-- Applies a validated config.set: a NEW configuration version, never an update. Locks the base version
-- (FOR NO KEY UPDATE) and re-reads the newest base after the lock, so two runs cannot both build on the
-- same version and lose one change. Returns {changed, configVersion}; raises a coded refusal.
CREATE FUNCTION core.admin_action_apply_config_set(p_action uuid, p_payload jsonb, p_requested_by uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_key    text := p_payload ->> 'key';
  v_new    bigint := (p_payload ->> 'value')::bigint;
  v_reg    record;
  v_grace  int := core.admin_action_setting('config_apply_grace_seconds');
  v_eff    timestamptz;
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
    v_eff := clock_timestamp() + make_interval(secs => v_grace);
    SELECT max(cv.id) INTO v_base FROM core.config_version cv WHERE cv.effective_from <= v_eff;
    PERFORM 1 FROM core.config_version cv WHERE cv.id = v_base FOR NO KEY UPDATE;
    EXIT WHEN v_base = (SELECT max(cv.id) FROM core.config_version cv WHERE cv.effective_from <= v_eff);
    IF v_tries >= 10 THEN
      PERFORM core.fail('BUSY', 'configuration is busy');
    END IF;
  END LOOP;
  SELECT cv.values INTO v_vals FROM core.config_version cv WHERE cv.id = v_base;
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

-- One due action: checks that it is intact and still the Super Admin's, validates it again, runs it.
CREATE FUNCTION core.admin_action_run(a audit.pending_action) RETURNS jsonb
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
  END IF;
  PERFORM core.fail('ADMIN_ACTION_UNKNOWN', 'that kind of action is not allowed');
  RETURN NULL;
END $$;

-- The jobs step: runs every due, still-queued action (at most p_limit, oldest first), each once. An
-- action another run holds is skipped (SKIP LOCKED); one that fails is marked FAILED with a code and
-- does not stop the others (each runs in its own sub-transaction); one that could not get its lock in
-- time stays QUEUED for the next run. Returns {executed, failed, skipped}.
CREATE FUNCTION core.admin_actions_execute_due(p_limit int DEFAULT 10) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_limit    int := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
  r          audit.pending_action;
  v_out      jsonb;
  v_executed int := 0;
  v_failed   int := 0;
  v_skipped  int := 0;
  v_state    text;
  v_hint     text;
  v_code     text;
BEGIN
  FOR r IN
    SELECT a.* FROM audit.pending_action a
     WHERE a.state = 'QUEUED' AND a.not_before <= clock_timestamp()
     ORDER BY a.not_before, a.id
     LIMIT v_limit
       FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      v_out := core.admin_action_run(r);
      UPDATE audit.pending_action a SET state = 'EXECUTED', executed_at = clock_timestamp(), outcome = v_out
       WHERE a.id = r.id;
      PERFORM core.admin_action_notify('admin_action_executed', r.id, r.action, r.payload ->> 'key', r.not_before);
      v_executed := v_executed + 1;
    EXCEPTION
      WHEN lock_not_available OR deadlock_detected OR serialization_failure THEN
        v_skipped := v_skipped + 1;      -- stays QUEUED; the next run tries again
      WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT;
        -- a coded refusal keeps its code; anything else is INTERNAL (no message, no values)
        v_code := CASE WHEN v_state = 'DM001' AND v_hint ~ '^[A-Z_]{3,40}$' THEN v_hint ELSE 'INTERNAL' END;
        UPDATE audit.pending_action a
           SET state = 'FAILED', executed_at = clock_timestamp(), outcome = jsonb_build_object('code', v_code)
         WHERE a.id = r.id;
        PERFORM audit.append_chained(NULL, 'SYSTEM', 'admin_action.fail', 'admin_action', r.id::text, r.reason,
          jsonb_build_object('kind', r.action, 'key', r.payload ->> 'key', 'code', v_code));
        PERFORM core.admin_action_notify('admin_action_failed', r.id, r.action, r.payload ->> 'key', r.not_before);
        v_failed := v_failed + 1;
    END;
  END LOOP;
  RETURN jsonb_build_object('executed', v_executed, 'failed', v_failed, 'skipped', v_skipped);
END $$;

-- ---------------------------------------------------------------- analytics: a database-only event
CREATE OR REPLACE FUNCTION analytics.event_names() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['page_view', 'search', 'product_view', 'cart_add', 'checkout_start',
               'purchase', 'sign_up', 'creator_unlock', 'shop_registered', 'listing_published',
               'review_submitted', 'review_hidden', 'console_config_changed']
$$;

CREATE OR REPLACE FUNCTION analytics.server_event_names() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['purchase', 'sign_up', 'creator_unlock', 'shop_registered', 'listing_published',
               'review_submitted', 'review_hidden', 'console_config_changed']
$$;

-- record_event as of 0061, refusing console_config_changed from any caller (only the executor writes it).
CREATE OR REPLACE FUNCTION analytics.record_event(p_name text, p_surface text, p_visitor_key bytea, p_place_key bytea,
                                       p_country text, p_region text, p_city text, p_device_class text,
                                       p_props jsonb)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_actor   uuid := core.actor_id();
  v_server  boolean := p_name = ANY (analytics.server_event_names());
  v_now     timestamptz;
  v_props   jsonb := COALESCE(p_props, '{}'::jsonb);
  v_product record;
BEGIN
  IF p_name IS NULL OR p_name <> ALL (analytics.event_names()) OR p_name IN ('listing_published', 'console_config_changed') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'unknown event name');
  END IF;
  IF v_server AND v_actor IS NULL THEN
    PERFORM core.fail('VALIDATION_FAILED', 'a server event needs a signed-in actor');
  END IF;
  IF p_surface IS NULL OR p_surface NOT IN ('shop', 'account', 'checkout', 'studio', 'console') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'unknown surface');
  END IF;
  IF v_server AND (p_visitor_key IS NOT NULL OR p_place_key IS NOT NULL) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'a server event carries no visitor or place key');
  END IF;
  IF NOT v_server AND (p_visitor_key IS NULL OR octet_length(p_visitor_key) <> 16
                       OR p_place_key IS NULL OR octet_length(p_place_key) <> 8) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'the visitor key is 16 bytes and the place key 8');
  END IF;
  IF p_country IS NULL OR p_country !~ '^[A-Z]{2}$'
     OR (p_region IS NOT NULL AND NOT analytics.region_ok(p_region))
     OR (p_city IS NOT NULL AND NOT analytics.city_ok(p_city))
     OR (p_country = 'ZZ' AND (p_region IS NOT NULL OR p_city IS NOT NULL)) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'the place is not valid');
  END IF;
  IF p_device_class IS NULL OR p_device_class NOT IN ('mobile', 'tablet', 'desktop', 'unknown') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'unknown device class');
  END IF;
  IF NOT analytics.props_valid(p_name, v_props) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'the props are not allowed for this event');
  END IF;
  IF v_props ? 'category' AND analytics.known_category(v_props ->> 'category') IS NULL
     AND p_name NOT IN ('product_view', 'cart_add') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'the category is not a catalog category');
  END IF;

  -- research opt-out (R15.2) and test accounts (R16.8): nothing is recorded
  IF v_actor IS NOT NULL AND EXISTS (SELECT 1 FROM core.user_profile up
                                      WHERE up.id = v_actor AND (up.research_opt_out OR up.is_test_account)) THEN
    RETURN false;
  END IF;

  IF p_name IN ('product_view', 'cart_add') THEN
    -- the product's category and company come from the catalog, never from the caller
    IF NOT v_props ? 'product_id' THEN
      PERFORM core.fail('VALIDATION_FAILED', 'this event names a product');
    END IF;
    SELECT p.id, p.category, p.company_id INTO v_product
      FROM core.product p WHERE p.id = (v_props ->> 'product_id')::uuid AND p.status = 'PUBLISHED';
    IF NOT FOUND THEN
      RETURN false;
    END IF;
    v_props := jsonb_strip_nulls(jsonb_build_object('product_id', v_product.id, 'company_id', v_product.company_id,
                                                    'category', analytics.known_category(v_product.category)));
  ELSIF p_name = 'shop_registered' THEN
    IF NOT EXISTS (SELECT 1 FROM core.company c WHERE c.owner_user_id = v_actor) THEN
      PERFORM core.fail('VALIDATION_FAILED', 'the actor has no company');
    END IF;
  END IF;

  v_now := CASE WHEN v_server THEN date_trunc('hour', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                ELSE date_trunc('minute', clock_timestamp()) END;
  INSERT INTO analytics.event (occurred_at, day, name, surface, visitor_key, place_key, signed_in, country, region,
                               city, device_class, props)
  VALUES (v_now, (v_now AT TIME ZONE 'UTC')::date, p_name, p_surface, p_visitor_key, p_place_key, v_actor IS NOT NULL,
          p_country, p_region, p_city, p_device_class, v_props);
  RETURN true;
END $$;

-- ---------------------------------------------------------------- privileges
REVOKE ALL ON FUNCTION
  core.admin_action_kinds(), core.config_key_registry(), core.admin_action_setting_defaults(),
  core.admin_action_setting(text), core.admin_action_rules(), core.admin_action_validate(text, jsonb),
  core.admin_action_notify(text, uuid, text, text, timestamptz), core.admin_action_json(audit.pending_action),
  core.admin_config_base_id(), core.admin_action_propose(text, jsonb, text), core.admin_action_cancel(uuid, text),
  core.admin_actions(text, int), core.admin_config_overview(), core.public_announcements(),
  core.admin_action_apply_config_set(uuid, jsonb, uuid, text), core.admin_action_run(audit.pending_action),
  core.admin_actions_execute_due(int), audit.guard_pending_action()
  FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;

-- the Super Admin's console commands and reads (each refuses anyone else) and the public announcement
GRANT EXECUTE ON FUNCTION core.admin_action_propose(text, jsonb, text), core.admin_action_cancel(uuid, text),
  core.admin_actions(text, int), core.admin_config_overview(), core.public_announcements()
  TO app_web;
-- the one function the jobs role gains
GRANT EXECUTE ON FUNCTION core.admin_actions_execute_due(int) TO app_jobs;

COMMENT ON FUNCTION core.admin_actions_execute_due(int) IS
  'The pending_action.execute job (LLD §9): runs each due, still-queued action once. TODO(email-sender): the '
  'outbox rows it writes (admin_action_executed, admin_action_failed) become the alert email once the relay exists.';
