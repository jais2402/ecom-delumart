-- Store handles (sixth security review, minors 5 and 6).
--
-- 5. Handle squatting: re-quoting held a handle indefinitely, for free. Now, under the handle's
--    reservation lock and the actor's progression lock (core.company_quote):
--    * a person holds at most one live reservation (a new quote releases the earlier ones; a
--      trigger refuses a second live one from any writer);
--    * quoting the handle one already holds live keeps the earlier expiry: a reservation is never
--      extended past `company_quote_ttl_seconds` (300) from the first quote;
--    * once a reservation of theirs has ended unpaid (expired, or released by another quote), the
--      same person cannot reserve that same handle again for `handle_requote_cooldown_minutes`
--      (30): HANDLE_RESERVED, and anyone else may take it meanwhile;
--    * at most `company_quotes_per_hour` (5) quotes per person per rolling hour (RATE_LIMITED); the
--      route also counts calls with core.rate_hit.
-- 6. Look-alike handles (`de1ulumart`, `deluiumart`, `admin-team`, `support-desk`) were accepted.
--    core.store_handle_lookalike(h): the handle's confusable-folded form (0→o, 1/i/l→l, 3→e, 4→a,
--    5→s, 7→t, 8→b, hyphens removed), or any of its hyphen-separated tokens folded, is a folded
--    reserved handle. Refused as HANDLE_TAKEN by core.store_handle_problem (quote and registration)
--    and by a CHECK on core.company for every new company (NOT VALID: handles registered before
--    this migration never change and are kept). Mirrors validateHandle in packages/core (a shared
--    test table keeps the two in agreement).

-- ---------------------------------------------------------------- 6. look-alikes
CREATE FUNCTION core.store_handle_fold(h text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT translate(replace(h, '-', ''), '0134578i', 'oleastbl')
$$;

CREATE FUNCTION core.store_handle_lookalike(h text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT h IS NOT NULL AND (
    core.store_handle_fold(h) = ANY (SELECT core.store_handle_fold(r) FROM unnest(core.reserved_store_handles()) r)
    OR EXISTS (SELECT 1 FROM unnest(string_to_array(h, '-')) t
                WHERE t <> '' AND core.store_handle_fold(t) = ANY (
                  SELECT core.store_handle_fold(r) FROM unnest(core.reserved_store_handles()) r)))
$$;

CREATE OR REPLACE FUNCTION core.store_handle_problem(handle text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN handle IS NULL OR NOT core.store_handle_valid(handle) THEN
      ARRAY['VALIDATION_FAILED', 'a handle is 3 to 24 lowercase letters, digits and single inner hyphens']
    WHEN handle = ANY (core.reserved_store_handles()) OR core.store_handle_lookalike(handle) THEN
      ARRAY['HANDLE_TAKEN', 'this handle is not available']
  END
$$;

ALTER TABLE core.company ADD CONSTRAINT company_handle_not_lookalike
  CHECK (handle IS NULL OR NOT core.store_handle_lookalike(handle)) NOT VALID;

-- ---------------------------------------------------------------- 5. reservations
ALTER TABLE core.handle_reservation ADD COLUMN released_at timestamptz;
CREATE INDEX handle_reservation_user ON core.handle_reservation (user_id, handle);

-- At most one live reservation per person, whoever writes it.
CREATE FUNCTION core.one_live_reservation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM core.handle_reservation r JOIN core.checkout_session cs ON cs.id = r.session_id
              WHERE r.user_id = NEW.user_id AND r.session_id <> NEW.session_id AND r.released_at IS NULL
                AND cs.state = 'OPEN' AND r.expires_at > clock_timestamp() AND cs.expires_at > clock_timestamp()) THEN
    RAISE EXCEPTION 'handle reservation: % already holds a live reservation', NEW.user_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER one_live BEFORE INSERT ON core.handle_reservation
  FOR EACH ROW EXECUTE FUNCTION core.one_live_reservation();

CREATE OR REPLACE FUNCTION core.company_quote(handle text, display_name text, description text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor   uuid := core.progression_actor();
  h       text := company_quote.handle;
  n       text := btrim(company_quote.display_name);
  d       text := btrim(COALESCE(company_quote.description, ''));
  problem text[];
  cfg     int := core.current_config_id();
  fee     bigint;
  balance bigint;
  sponsor bigint;
  payable bigint;
  sid     uuid := core.uuid_v7();
  expires timestamptz;
  kept    timestamptz;
  quote   jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.creator_entitlement ce WHERE ce.user_id = actor) THEN
    PERFORM core.fail('CREATOR_LOCKED', 'unlock creator access first');
  END IF;
  IF EXISTS (SELECT 1 FROM core.company c WHERE c.owner_user_id = actor) THEN
    PERFORM core.fail('COMPANY_EXISTS', 'you already have a company');
  END IF;
  problem := COALESCE(core.store_handle_problem(h), core.store_text_problem(n, d));
  IF problem IS NOT NULL THEN
    PERFORM core.fail(problem[1], problem[2]);
  END IF;
  -- quotes per person per hour (counted under the actor's progression lock)
  IF (SELECT count(*) FROM core.checkout_session cs
       WHERE cs.user_id = actor AND cs.type = 'COMPANY_REGISTRATION' AND cs.created_at > clock_timestamp() - interval '1 hour')
     >= core.config_int(cfg, ARRAY['company_quotes_per_hour'], 5) THEN
    PERFORM core.fail('RATE_LIMITED', 'you have asked for as many registration quotes as you may this hour');
  END IF;
  -- the handle's reservation lock: one quote or registration of this handle at a time
  PERFORM core.lock_actor('core.handle_reservation', core.handle_lock_key(h));
  IF EXISTS (SELECT 1 FROM core.company c WHERE lower(c.handle) = lower(h)) THEN
    PERFORM core.fail('HANDLE_TAKEN', 'this handle is not available');
  END IF;
  IF core.handle_reserved_by_other(h, actor) THEN
    PERFORM core.fail('HANDLE_RESERVED', 'this handle is being registered by someone else; try again later');
  END IF;
  -- the actor's own live reservation of this handle keeps its expiry (never extended)
  SELECT min(r.expires_at) INTO kept
    FROM core.handle_reservation r JOIN core.checkout_session cs ON cs.id = r.session_id
   WHERE r.user_id = actor AND r.handle = h AND r.released_at IS NULL AND cs.state = 'OPEN'
     AND r.expires_at > clock_timestamp() AND cs.expires_at > clock_timestamp();
  -- a reservation of theirs that ended unpaid holds this handle back from them for a while
  IF kept IS NULL AND EXISTS (
       SELECT 1 FROM core.handle_reservation r JOIN core.checkout_session cs ON cs.id = r.session_id
        WHERE r.user_id = actor AND r.handle = h AND cs.state <> 'SUCCEEDED'
          AND LEAST(r.expires_at, COALESCE(r.released_at, r.expires_at)) <= clock_timestamp()
          AND LEAST(r.expires_at, COALESCE(r.released_at, r.expires_at))
                > clock_timestamp() - make_interval(mins => core.config_int(cfg, ARRAY['handle_requote_cooldown_minutes'], 30)::int)) THEN
    PERFORM core.fail('HANDLE_RESERVED', 'your earlier hold on this handle lapsed; try again later');
  END IF;
  -- the actor's earlier quotes end: their reservations are released
  UPDATE core.handle_reservation r SET released_at = clock_timestamp()
   WHERE r.user_id = actor AND r.released_at IS NULL
     AND r.session_id IN (SELECT cs.id FROM core.checkout_session cs
                           WHERE cs.user_id = actor AND cs.type = 'COMPANY_REGISTRATION' AND cs.state = 'OPEN');
  UPDATE core.checkout_session cs SET state = 'EXPIRED'
   WHERE cs.user_id = actor AND cs.type = 'COMPANY_REGISTRATION' AND cs.state = 'OPEN';

  fee := core.config_paise(cfg, ARRAY['company_registration_fee_paise'], 50000000);
  SELECT w.available_paise INTO balance FROM ledger.ledger_account la JOIN ledger.wallet w ON w.account_id = la.id
   WHERE la.user_id = actor AND la.type = 'USER';
  sponsor := core.sponsorship_for(actor, balance, fee);
  payable := fee - sponsor;
  quote := jsonb_build_object('version', 1, 'kind', 'COMPANY_REGISTRATION', 'handle', h, 'displayName', n,
                              'description', d, 'feePaise', fee::text, 'configVersion', cfg);
  INSERT INTO core.checkout_session (id, user_id, type, quote, total_paise, config_version, expires_at)
  VALUES (sid, actor, 'COMPANY_REGISTRATION', quote, fee, cfg,
          COALESCE(kept, clock_timestamp() + make_interval(secs => core.config_int(cfg, ARRAY['company_quote_ttl_seconds'], 300))))
  RETURNING expires_at INTO expires;
  INSERT INTO core.handle_reservation (session_id, user_id, handle, expires_at) VALUES (sid, actor, h, expires);
  RETURN jsonb_build_object(
    'sessionId', sid, 'expiresAt', expires, 'handle', h, 'displayName', n, 'description', d,
    'feePaise', fee::text, 'sponsorshipPaise', sponsor::text, 'payablePaise', payable::text,
    'balancePaise', balance::text,
    'balanceAfterPaise', CASE WHEN balance >= payable THEN (balance - payable)::text END,
    'sufficient', balance >= payable);
END $$;

REVOKE ALL ON FUNCTION core.store_handle_fold(text), core.store_handle_lookalike(text), core.one_live_reservation()
FROM PUBLIC;
