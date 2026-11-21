-- Money commands (security review, round 4): the ONLY way the application writes money,
-- identity, orders, payments, stock or stock counters.
--
-- Each command is a SECURITY DEFINER function owned by the migration role, with a pinned
-- search_path (pg_catalog, pg_temp) and schema-qualified references. Each one:
--   * derives the acting user itself from the sign-in session (core.actor_id(), 0001) and
--     refuses (FORBIDDEN) without one; it takes no user id argument;
--   * takes its locks in the canonical order (LLD §4) under its own lock_timeout (SET clause);
--   * writes as the owner, then fires every deferred structural check of 0003/0014/0016
--     SYNCHRONOUSLY (SET CONSTRAINTS ALL IMMEDIATE) before returning, which also seals the
--     journal and order group it wrote (R9, 0016): nothing can be added to them afterwards.
-- EXECUTE is granted to app_pay only (core.purge_idempotency_records: app_jobs only).
--
-- Every amount is computed by the TypeScript pricing function (packages/core/src/pricing) and
-- handed in; the functions re-derive it in SQL from the rows they read (core.price_cart, the
-- same rules the structural checks of 0016 apply, including core.flat_split) and refuse
-- anything that differs, so a caller cannot store a price, total, discount or fee of its own.
--
-- Business refusals use SQLSTATE DM001 with the stable error code in HINT and a message that
-- never contains a session id. Functions whose refusals must leave a trace (a failed coupon
-- lookup, a failed purchase attempt) return the refusal as {"error": {...}} instead of
-- raising, so that the trace commits.

-- ---------------------------------------------------------------- helpers
CREATE FUNCTION core.fail(code text, message text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'DM001', MESSAGE = message, HINT = code;
END $$;

CREATE FUNCTION core.err(code text, message text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('error', jsonb_build_object('code', code, 'message', message))
$$;

-- RFC 9562 version 7 (time-ordered) ids, like uuidv7() in packages/db/src/uuid.ts.
CREATE FUNCTION core.uuid_v7() RETURNS uuid
LANGUAGE sql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
  SELECT encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid())
           PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
           FROM 1 FOR 6), 52, 1), 53, 1), 'hex')::uuid
$$;

CREATE FUNCTION core.current_config_id() RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT cv.id FROM core.config_version cv WHERE cv.effective_from <= now() ORDER BY cv.id DESC LIMIT 1
$$;

CREATE FUNCTION core.switch_on(switch_name text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE((SELECT sw.enabled FROM core.system_switch sw WHERE sw.name = switch_name), false)
$$;

CREATE FUNCTION core.is_uuid(v text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT v IS NOT NULL AND v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

-- ---------------------------------------------------------------- idempotency (LLD §5.3)
ALTER TABLE core.idempotency_record
  ADD CONSTRAINT idempotency_key_length CHECK (char_length(key) BETWEEN 1 AND 200);

-- Insert-or-lock the record; same key + different request is a CONFLICT. A user holds at most
-- `idempotency_live_records_max` (1,000) records younger than `idempotency_retention_hours`
-- (24 h); older ones are purged by core.purge_idempotency_records() (app_jobs).
CREATE FUNCTION core.idem_begin(actor uuid, cmd text, idem_key text, hash bytea)
RETURNS core.idempotency_record
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  rec core.idempotency_record;
  cfg int := core.current_config_id();
BEGIN
  IF idem_key IS NULL OR char_length(idem_key) NOT BETWEEN 1 AND 200 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'idempotency key must be 1–200 characters');
  END IF;
  SELECT * INTO rec FROM core.idempotency_record r
   WHERE r.user_id = actor AND r.command = cmd AND r.key = idem_key FOR UPDATE;
  IF NOT FOUND THEN
    IF (SELECT count(*) FROM core.idempotency_record r
         WHERE r.user_id = actor
           AND r.created_at > now() - make_interval(hours => core.config_int(cfg, ARRAY['idempotency_retention_hours'], 24)::int))
       >= core.config_int(cfg, ARRAY['idempotency_live_records_max'], 1000) THEN
      PERFORM core.fail('RATE_LIMITED', 'too many requests; try again later');
    END IF;
    INSERT INTO core.idempotency_record (user_id, command, key, request_hash)
    VALUES (actor, cmd, idem_key, hash) ON CONFLICT DO NOTHING;
    SELECT * INTO rec FROM core.idempotency_record r
     WHERE r.user_id = actor AND r.command = cmd AND r.key = idem_key FOR UPDATE;
  END IF;
  IF rec.request_hash IS DISTINCT FROM hash THEN
    PERFORM core.fail('CONFLICT', 'this idempotency key was used for a different request');
  END IF;
  RETURN rec;
END $$;

CREATE FUNCTION core.purge_idempotency_records() RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n bigint;
BEGIN
  DELETE FROM core.idempotency_record r
   WHERE r.created_at < now() - make_interval(
           hours => core.config_int(core.current_config_id(), ARRAY['idempotency_retention_hours'], 24)::int);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ---------------------------------------------------------------- coupon lookups (LLD §11.2)
-- Failed coupon-code lookups per actor; after `coupon_lookup_failures_per_hour` (10) in the
-- last hour every lookup answers COUPON_INVALID, whatever the code.
CREATE TABLE core.coupon_lookup_failure (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,   -- the actor (auth.users id); a profile may not exist yet
  at      timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX coupon_lookup_failure_user ON core.coupon_lookup_failure (user_id, at);
ALTER TABLE core.coupon_lookup_failure ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.coupon_lookup_failure FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;
GRANT SELECT, DELETE ON core.coupon_lookup_failure TO app_jobs;   -- retention
CREATE POLICY jobs_all ON core.coupon_lookup_failure TO app_jobs USING (true) WITH CHECK (true);

-- What stops the actor redeeming this coupon in a cart of these companies (owners: company id
-- -> owner user id), as [code, message]; NULL when usable. Expiry by the clock.
CREATE FUNCTION core.coupon_problem(cp_id uuid, actor uuid, owners jsonb) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  c core.coupon;
BEGIN
  SELECT * INTO c FROM core.coupon WHERE id = cp_id;
  IF NOT FOUND OR c.status <> 'ACTIVE' OR c.scope <> 'MERCHANT' THEN
    RETURN ARRAY['COUPON_INVALID', 'coupon is not active'];
  END IF;
  IF (c.starts_at IS NOT NULL AND c.starts_at > clock_timestamp()) OR (c.ends_at IS NOT NULL AND c.ends_at <= clock_timestamp()) THEN
    RETURN ARRAY['COUPON_INVALID', 'coupon is outside its validity window'];
  END IF;
  IF c.max_redemptions IS NOT NULL AND c.redeemed >= c.max_redemptions THEN
    RETURN ARRAY['COUPON_INVALID', 'coupon has reached its redemption cap'];
  END IF;
  IF NOT (owners ? c.company_id::text) THEN
    RETURN ARRAY['COUPON_NOT_APPLICABLE', 'coupon belongs to no seller in the cart'];
  END IF;
  IF owners ->> c.company_id::text = actor::text THEN
    RETURN ARRAY['COUPON_NOT_APPLICABLE', 'a company owner cannot redeem their own coupon'];
  END IF;
  IF EXISTS (SELECT 1 FROM core.coupon_redemption r WHERE r.coupon_id = c.id AND r.user_id = actor) THEN
    RETURN ARRAY['COUPON_NOT_APPLICABLE', 'coupon already redeemed by this buyer'];
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------- pricing, re-derived (LLD §5.1)
-- The pricing function's rules in SQL, for verification: given the lines (in pricing order:
-- productId, sellerId = company id or 'SEED', listPaise, freeStdDelivery), the merchant coupon
-- (companyId, kind, value, minSpendPaise) or NULL, the speed per seller, membership and the
-- configuration, returns exactly what price() returns, serialised with money as decimal
-- strings: {lines: [{productId, sellerId, listPaise, sellerDisc, platformDisc, fee}],
-- sellers: [{sellerId, speed, list, sellerDisc, platformDisc, fee, deliveryBuyer, deliverySeller,
-- net}] (first-appearance order), postings: [{account, amount}], total}. Refusals price()
-- raises are raised the same way (DM001). No platform coupons exist yet: platform discounts
-- are zero and MINT is never posted.
CREATE FUNCTION core.price_cart(cfg int, member boolean, coupon jsonb, lines jsonb, speeds jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n        int := COALESCE(jsonb_array_length(lines), 0);
  pid      text[];
  sel      text[];
  lst      bigint[];
  is_free  boolean[];
  sd       bigint[];
  fee      bigint[];
  fee_pct  bigint := core.config_int(cfg, ARRAY['fee_percent'], 5);
  pct_min  bigint := core.config_int(cfg, ARRAY['coupon_percent_min'], 1);
  pct_max  bigint := core.config_int(cfg, ARRAY['coupon_percent_max'], 90);
  elig     int[];
  split    bigint[];
  cvalue   bigint;
  min_spend bigint;
  sellers  text[];
  sid      text;
  sp       text;
  dfee     bigint;
  funded   boolean;
  s_list   bigint;
  s_sd     bigint;
  s_fee    bigint;
  s_db     bigint;
  s_ds     bigint;
  s_net    bigint;
  total    bigint := 0;
  sink     bigint := 0;
  out_lines   jsonb := '[]';
  out_sellers jsonb := '[]';
  credits     jsonb := '[]';
  postings    jsonb;
  i        int;
BEGIN
  IF n = 0 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'a quote needs at least one line');
  END IF;
  SELECT array_agg(x ->> 'productId' ORDER BY o), array_agg(x ->> 'sellerId' ORDER BY o),
         array_agg((x ->> 'listPaise')::bigint ORDER BY o), array_agg((x ->> 'freeStdDelivery')::boolean ORDER BY o)
    INTO pid, sel, lst, is_free
    FROM jsonb_array_elements(lines) WITH ORDINALITY AS t(x, o);
  sd := array_fill(0::bigint, ARRAY[n]);
  fee := array_fill(0::bigint, ARRAY[n]);

  -- 1. seller discount (merchant coupon, only on that company's lines), floor ₹100 per line
  IF coupon IS NOT NULL AND jsonb_typeof(coupon) = 'object' THEN
    cvalue := (coupon ->> 'value')::bigint;
    IF (coupon ->> 'kind' = 'PERCENT' AND (cvalue < pct_min OR cvalue > pct_max))
       OR (coupon ->> 'kind' = 'FLAT' AND cvalue <= 0) OR coupon ->> 'kind' NOT IN ('PERCENT', 'FLAT') THEN
      PERFORM core.fail('COUPON_INVALID', 'coupon value is outside the allowed range');
    END IF;
    IF coupon ->> 'companyId' = 'SEED' THEN
      PERFORM core.fail('COUPON_NOT_APPLICABLE', 'merchant coupons cannot apply to seed stock');
    END IF;
    elig := ARRAY(SELECT k FROM generate_series(1, n) k WHERE sel[k] = coupon ->> 'companyId' ORDER BY k);
    IF cardinality(elig) = 0 THEN
      PERFORM core.fail('COUPON_NOT_APPLICABLE', 'coupon applies to no item in the cart');
    END IF;
    min_spend := COALESCE((coupon ->> 'minSpendPaise')::bigint, 0);
    IF min_spend > 0 AND (SELECT SUM(lst[k]) FROM unnest(elig) k) < min_spend THEN
      PERFORM core.fail('COUPON_NOT_APPLICABLE', 'minimum spend not met');
    END IF;
    IF coupon ->> 'kind' = 'PERCENT' THEN
      FOREACH i IN ARRAY elig LOOP
        sd[i] := LEAST(lst[i] * cvalue / 100, GREATEST(lst[i] - 10000, 0));
      END LOOP;
    ELSE
      split := core.flat_split(cvalue, ARRAY(SELECT lst[k] FROM unnest(elig) WITH ORDINALITY AS e(k, o) ORDER BY o));
      FOR i IN 1 .. cardinality(elig) LOOP
        sd[elig[i]] := split[i];
      END LOOP;
    END IF;
  END IF;

  -- 3. fee per line (seed lines pay none)
  FOR i IN 1 .. n LOOP
    fee[i] := CASE WHEN sel[i] = 'SEED' THEN 0 ELSE (lst[i] - sd[i]) * fee_pct / 100 END;
    out_lines := out_lines || jsonb_build_array(jsonb_build_object(
      'productId', pid[i], 'sellerId', sel[i], 'listPaise', lst[i]::text, 'sellerDisc', sd[i]::text,
      'platformDisc', '0', 'fee', fee[i]::text));
  END LOOP;

  -- 4. per seller order, in order of first appearance
  sellers := ARRAY(SELECT s FROM unnest(sel) WITH ORDINALITY AS x(s, o) GROUP BY s ORDER BY min(o));
  FOREACH sid IN ARRAY sellers LOOP
    sp := speeds ->> sid;
    IF sp IS NULL OR sp NOT IN ('STANDARD', 'EXPRESS', 'ZAP') THEN
      PERFORM core.fail('VALIDATION_FAILED', 'no delivery speed chosen for a seller');
    END IF;
    dfee := core.delivery_fee_paise(cfg, sp, member);
    SELECT bool_and(is_free[k]), SUM(lst[k]), SUM(sd[k]), SUM(fee[k])
      INTO funded, s_list, s_sd, s_fee
      FROM generate_series(1, n) k WHERE sel[k] = sid;
    funded := sp = 'STANDARD' AND funded;
    s_ds := CASE WHEN funded THEN dfee ELSE 0 END;
    s_db := CASE WHEN funded THEN 0 ELSE dfee END;
    s_net := s_list - s_sd - s_fee - s_ds;
    IF s_net < 0 THEN
      PERFORM core.fail('DELIVERY_UNAVAILABLE', 'seller-funded delivery exceeds the seller''s proceeds');
    END IF;
    total := total + s_list - s_sd + s_db;
    sink := sink + s_fee + s_db + s_ds + CASE WHEN sid = 'SEED' THEN s_net ELSE 0 END;
    IF sid <> 'SEED' AND s_net > 0 THEN
      credits := credits || jsonb_build_array(jsonb_build_object('account', sid, 'amount', s_net::text));
    END IF;
    out_sellers := out_sellers || jsonb_build_array(jsonb_build_object(
      'sellerId', sid, 'speed', sp, 'list', s_list::text, 'sellerDisc', s_sd::text, 'platformDisc', '0',
      'fee', s_fee::text, 'deliveryBuyer', s_db::text, 'deliverySeller', s_ds::text, 'net', s_net::text));
  END LOOP;

  postings := jsonb_build_array(jsonb_build_object('account', 'BUYER', 'amount', (-total)::text)) || credits;
  IF sink > 0 THEN
    postings := postings || jsonb_build_array(jsonb_build_object('account', 'SINK', 'amount', sink::text));
  END IF;
  RETURN jsonb_build_object('lines', out_lines, 'sellers', out_sellers, 'postings', postings, 'total', total::text);
END $$;

-- ---------------------------------------------------------------- provisioning (LLD §7.1)
-- The ONLY way a profile is created: for the signed-in actor (whose auth.users row the
-- profile's foreign key requires). The tombstone rule is applied, in this same call, to the
-- fingerprints stored on the locked profile row and to the ones presented. Idempotent under concurrency: concurrent calls
-- serialise on the profile row and return the records the first one created; the STARTER
-- grant is never repeated (US-01, US-14).
CREATE FUNCTION core.provision_account(email_fingerprint bytea, phone_fingerprint bytea, card_number text,
                                       alias text, upi_style_id text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor      uuid := core.actor_id();
  tombstoned boolean;
  existing   record;
  acct       uuid := core.uuid_v7();
  bank       uuid := core.uuid_v7();
  card       uuid := core.uuid_v7();
  journal    uuid;
  grant_id   uuid;
  cfg        int;
  amount     bigint := 0;
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  PERFORM ledger.require_read_committed();
  IF email_fingerprint IS NULL OR octet_length(email_fingerprint) <> 32
     OR (phone_fingerprint IS NOT NULL AND octet_length(phone_fingerprint) <> 32) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'fingerprints are 32-byte HMACs');
  END IF;

  -- No target on ON CONFLICT: concurrent calls for the same user can collide on the
  -- fingerprint indexes before the primary key. If our row is still absent afterwards, a
  -- fingerprint belongs to a different account.
  INSERT INTO core.user_profile (id, email_fingerprint, phone_fingerprint, phone_verified_at)
  VALUES (actor, email_fingerprint, phone_fingerprint, CASE WHEN phone_fingerprint IS NOT NULL THEN now() END)
  ON CONFLICT DO NOTHING;
  -- the tombstone rule applies to the fingerprints stored on the profile AND to the ones
  -- presented now: a profile that somehow carries other fingerprints earns no grant for an
  -- identity that is tombstoned
  SELECT core.identity_is_tombstoned(u.email_fingerprint, u.phone_fingerprint)
         OR core.identity_is_tombstoned(provision_account.email_fingerprint, provision_account.phone_fingerprint)
    INTO tombstoned
    FROM core.user_profile u WHERE u.id = actor FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM core.fail('CONFLICT', 'This phone number or email already belongs to another account.');
  END IF;

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

  SET CONSTRAINTS ALL DEFERRED;   -- whatever mode the caller left: the checks run below, synchronously
  INSERT INTO ledger.ledger_account (id, type, user_id) VALUES (acct, 'USER', actor);
  INSERT INTO core.bank_account (id, user_id, ledger_account_id, alias, upi_style_id)
  VALUES (bank, actor, acct, alias, upi_style_id);
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
  INSERT INTO core.virtual_card (id, user_id, bank_account_id, sequence, card_number, status)
  VALUES (card, actor, bank, 1, card_number, 'ACTIVE');
  UPDATE core.user_profile SET provisioned_at = now() WHERE id = actor;

  SET CONSTRAINTS ALL IMMEDIATE;   -- every structural check, now (R9 seals the grant journal)
  SET CONSTRAINTS ALL DEFERRED;    -- back to the declared mode for the rest of the caller's transaction
  RETURN jsonb_build_object('created', true, 'userId', actor, 'ledgerAccountId', acct, 'bankAccountId', bank,
    'cardId', card, 'cardNumber', card_number, 'walletPaise', amount::text, 'starterJournalId', journal,
    'grantRecordId', grant_id);
END $$;

-- ---------------------------------------------------------------- checkout (LLD §8.4)
-- Resolves the buyer's choices against the current rows: {productIds, speedBySeller,
-- couponCode?, addressId?}. Returns {inputs: {...}} (what the pricing function needs) or
-- {error: {code, message}}. A coupon code is looked up by exact normalised code among the
-- sellers of THIS cart only; a miss is recorded for the actor (it commits: nothing here raises
-- on a refusal).
CREATE FUNCTION core.resolve_cart(actor uuid, choices jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cfg        int := core.current_config_id();
  max_lines  bigint;
  ids        uuid[];
  n          int;
  code       text;
  address_id uuid;
  speeds_in  jsonb;
  p          record;
  owners     jsonb := '{}';
  company_ids uuid[];
  cp_id      uuid;
  cp         core.coupon;
  problem    text[];
  lines      jsonb := '[]';
  sellers    text[];
  sid        text;
  sp         text;
  speeds     jsonb := '{}';
  offered    boolean;
  member     boolean;
  coupon_j   jsonb;
  r          record;
BEGIN
  IF cfg IS NULL THEN
    RETURN core.err('MAINTENANCE', 'no effective configuration version');
  END IF;
  IF jsonb_typeof(choices) IS DISTINCT FROM 'object' OR jsonb_typeof(choices -> 'productIds') IS DISTINCT FROM 'array' THEN
    RETURN core.err('VALIDATION_FAILED', 'productIds must be a list');
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(choices -> 'productIds') x
              WHERE jsonb_typeof(x) <> 'string' OR NOT core.is_uuid(x #>> '{}')) THEN
    RETURN core.err('VALIDATION_FAILED', 'productId must be a uuid');
  END IF;
  ids := ARRAY(SELECT (x #>> '{}')::uuid FROM jsonb_array_elements(choices -> 'productIds') WITH ORDINALITY AS t(x, o) ORDER BY o);
  n := cardinality(ids);
  IF (SELECT count(DISTINCT i) FROM unnest(ids) i) <> n THEN
    RETURN core.err('VALIDATION_FAILED', 'each product appears once (quantity one)');
  END IF;
  speeds_in := COALESCE(choices -> 'speedBySeller', '{}');
  IF jsonb_typeof(speeds_in) <> 'object' OR EXISTS (
       SELECT 1 FROM jsonb_each(speeds_in) e
        WHERE jsonb_typeof(e.value) <> 'string' OR e.value #>> '{}' NOT IN ('STANDARD', 'EXPRESS', 'ZAP')) THEN
    RETURN core.err('VALIDATION_FAILED', 'unknown delivery speed');
  END IF;
  IF jsonb_typeof(choices -> 'addressId') = 'string' AND core.is_uuid(choices ->> 'addressId') THEN
    address_id := (choices ->> 'addressId')::uuid;
  ELSIF COALESCE(jsonb_typeof(choices -> 'addressId'), 'null') <> 'null' THEN
    RETURN core.err('VALIDATION_FAILED', 'addressId must be a uuid');
  END IF;
  IF jsonb_typeof(choices -> 'couponCode') = 'string' THEN
    code := upper(btrim(choices ->> 'couponCode'));
    IF char_length(code) > 64 THEN
      RETURN core.err('VALIDATION_FAILED', 'coupon code is too long');
    END IF;
  ELSIF COALESCE(jsonb_typeof(choices -> 'couponCode'), 'null') <> 'null' THEN
    RETURN core.err('VALIDATION_FAILED', 'coupon code must be text');
  END IF;
  max_lines := core.config_int(cfg, ARRAY['cart_max_lines'], 20);
  IF n = 0 OR n > max_lines THEN
    RETURN core.err('VALIDATION_FAILED', format('a checkout has 1–%s lines', max_lines));
  END IF;

  -- products: published, with a current version, in stock
  FOR i IN 1 .. n LOOP
    SELECT pr.status, pr.inventory_mode, pr.available_units, v.id AS version_id
      INTO p FROM core.product pr LEFT JOIN core.product_version v ON v.id = pr.current_version_id
     WHERE pr.id = ids[i];
    IF NOT FOUND OR p.status <> 'PUBLISHED' OR p.version_id IS NULL THEN
      RETURN core.err('PRODUCT_UNAVAILABLE', 'a product is not available');
    END IF;
    IF p.inventory_mode IN ('STANDARD_STOCKED', 'EXCLUSIVE') AND p.available_units <= 0 THEN
      RETURN core.err('SOLD_OUT', 'a product is sold out');
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM core.ownership o WHERE o.user_id = actor AND o.product_id = ANY(ids)) THEN
    RETURN core.err('ALREADY_OWNED', 'you already own a product in this cart');
  END IF;

  company_ids := ARRAY(SELECT DISTINCT pr.company_id FROM core.product pr WHERE pr.id = ANY(ids) AND pr.company_id IS NOT NULL);
  FOR r IN SELECT c.id, c.owner_user_id FROM core.company c WHERE c.id = ANY(company_ids) LOOP
    owners := owners || jsonb_build_object(r.id::text, r.owner_user_id);
  END LOOP;

  -- coupon: exact code among this cart's sellers; failures counted per actor
  IF code IS NOT NULL THEN
    IF (SELECT count(*) FROM core.coupon_lookup_failure f
         WHERE f.user_id = actor AND f.at > clock_timestamp() - interval '1 hour')
       >= core.config_int(cfg, ARRAY['coupon_lookup_failures_per_hour'], 10) THEN
      RETURN core.err('COUPON_INVALID', 'coupon is not valid');
    END IF;
    SELECT c.id INTO cp_id FROM core.coupon c
     WHERE c.scope = 'MERCHANT' AND c.status = 'ACTIVE' AND c.code_normalised = code AND c.company_id = ANY(company_ids)
     ORDER BY c.id LIMIT 1;
    IF cp_id IS NULL THEN
      INSERT INTO core.coupon_lookup_failure (user_id) VALUES (actor);
      RETURN core.err('COUPON_INVALID', 'coupon is not valid');
    END IF;
    problem := core.coupon_problem(cp_id, actor, owners);
    IF problem IS NOT NULL THEN
      RETURN core.err(problem[1], problem[2]);
    END IF;
    SELECT * INTO cp FROM core.coupon WHERE id = cp_id;
    coupon_j := jsonb_build_object('id', cp.id, 'companyId', cp.company_id, 'code', cp.code_normalised, 'kind', cp.kind,
                                   'value', cp.value::text, 'minSpendPaise', cp.min_spend_paise::text);
  END IF;

  -- never from one's own (or an unknown) company; lines in pricing order
  FOR i IN 1 .. n LOOP
    SELECT pr.id, pr.company_id, pr.inventory_mode, pr.free_standard_delivery, v.id AS version_id, v.price_paise
      INTO p FROM core.product pr JOIN core.product_version v ON v.id = pr.current_version_id
     WHERE pr.id = ids[i];
    IF p.company_id IS NOT NULL AND (NOT (owners ? p.company_id::text) OR owners ->> p.company_id::text = actor::text) THEN
      RETURN core.err(CASE WHEN owners ? p.company_id::text THEN 'SELF_PURCHASE' ELSE 'PRODUCT_UNAVAILABLE' END,
                      'you cannot buy from your own company');
    END IF;
    lines := lines || jsonb_build_array(jsonb_build_object(
      'productId', p.id, 'productVersionId', p.version_id, 'sellerId', COALESCE(p.company_id::text, 'SEED'),
      'companyId', p.company_id, 'listPaise', p.price_paise::text, 'freeStdDelivery', p.free_standard_delivery,
      'inventoryMode', p.inventory_mode));
  END LOOP;

  -- a delivery speed per seller, offered for every product of that seller (LLD §5.2)
  sellers := ARRAY(SELECT l ->> 'sellerId' FROM jsonb_array_elements(lines) WITH ORDINALITY AS x(l, o)
                    GROUP BY l ->> 'sellerId' ORDER BY min(o));
  FOREACH sid IN ARRAY sellers LOOP
    sp := speeds_in ->> sid;
    IF sp IS NULL THEN
      RETURN core.err('VALIDATION_FAILED', 'choose a delivery speed for every seller');
    END IF;
    SELECT CASE sp
             WHEN 'STANDARD' THEN true
             WHEN 'EXPRESS' THEN bool_and(pr.offers_express)
             ELSE CASE WHEN sid = 'SEED' THEN bool_and(pr.zap_flag)
                       ELSE bool_and(EXISTS (SELECT 1 FROM core.inventory_unit u JOIN core.warehouse w ON w.id = u.warehouse_id
                                              WHERE u.product_id = pr.id AND u.state = 'AVAILABLE' AND w.zap_hub)) END
           END
      INTO offered
      FROM core.product pr
     WHERE pr.id = ANY(ids) AND COALESCE(pr.company_id::text, 'SEED') = sid;
    IF NOT offered THEN
      RETURN core.err('DELIVERY_UNAVAILABLE', 'that delivery speed is not offered');
    END IF;
    speeds := speeds || jsonb_build_object(sid, sp);
  END LOOP;

  IF address_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM private.address a WHERE a.id = address_id AND a.user_id = actor) THEN
    RETURN core.err('NOT_FOUND', 'address not found');
  END IF;
  member := EXISTS (SELECT 1 FROM core.membership m
                     WHERE m.user_id = actor AND m.starts_at <= clock_timestamp() AND m.ends_at > clock_timestamp());
  RETURN jsonb_build_object('inputs', jsonb_build_object(
    'configVersion', cfg, 'isMember', member, 'lines', lines, 'speedBySeller', speeds,
    'coupon', coupon_j, 'addressId', address_id));
END $$;

-- The request a checkout idempotency key stands for (products, speeds, coupon, address).
CREATE FUNCTION core.checkout_request_hash(choices jsonb) RETURNS bytea
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT sha256(convert_to(jsonb_build_object(
    'productIds', choices -> 'productIds',
    'speeds', COALESCE(choices -> 'speedBySeller', '{}'),
    'coupon', CASE WHEN jsonb_typeof(choices -> 'couponCode') = 'string' THEN to_jsonb(upper(btrim(choices ->> 'couponCode'))) ELSE 'null' END,
    'addressId', COALESCE(choices -> 'addressId', 'null'))::text, 'UTF8'))
$$;

-- Step 1 of checkout: the inputs the pricing function needs ({inputs}), a stored result for a
-- completed idempotency key ({replay}), or a refusal ({error}).
CREATE FUNCTION core.checkout_inputs(choices jsonb, idempotency_key text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor uuid := core.actor_id();
  rec   core.idempotency_record;
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  IF idempotency_key IS NULL OR char_length(idempotency_key) NOT BETWEEN 1 AND 200 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'idempotency key must be 1–200 characters');
  END IF;
  SELECT * INTO rec FROM core.idempotency_record r
   WHERE r.user_id = actor AND r.command = 'checkout.create' AND r.key = idempotency_key;
  IF FOUND AND rec.request_hash <> core.checkout_request_hash(choices) THEN
    PERFORM core.fail('CONFLICT', 'this idempotency key was used for a different request');
  END IF;
  IF FOUND AND rec.status IS NOT NULL THEN
    RETURN jsonb_build_object('replay', rec.response);
  END IF;
  RETURN core.resolve_cart(actor, choices);
END $$;

-- Step 2 of checkout: choices plus `priced`, the pricing function's result for the inputs of
-- step 1. Re-resolves the choices, re-derives every amount in SQL and stores the immutable
-- quote only when `priced` is exactly that. Returns {result: {sessionId, expiresAt, quote}},
-- {replay: ...} or {error}.
CREATE FUNCTION core.create_checkout_session(choices jsonb, idempotency_key text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor    uuid := core.actor_id();
  hash     bytea;
  rec      core.idempotency_record;
  resolved jsonb;
  inputs   jsonb;
  cfg      int;
  priced   jsonb;
  quote    jsonb;
  sid      uuid := core.uuid_v7();
  expires  timestamptz;
  stored   jsonb;
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  PERFORM ledger.require_read_committed();
  IF idempotency_key IS NULL OR char_length(idempotency_key) NOT BETWEEN 1 AND 200 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'idempotency key must be 1–200 characters');
  END IF;
  hash := core.checkout_request_hash(choices);
  SELECT * INTO rec FROM core.idempotency_record r
   WHERE r.user_id = actor AND r.command = 'checkout.create' AND r.key = idempotency_key;
  IF FOUND AND rec.request_hash <> hash THEN
    PERFORM core.fail('CONFLICT', 'this idempotency key was used for a different request');
  END IF;
  IF FOUND AND rec.status IS NOT NULL THEN
    RETURN jsonb_build_object('replay', rec.response);
  END IF;

  resolved := core.resolve_cart(actor, choices);
  IF resolved ? 'error' THEN
    RETURN resolved;
  END IF;
  inputs := resolved -> 'inputs';
  cfg := (inputs ->> 'configVersion')::int;
  priced := core.price_cart(cfg, (inputs ->> 'isMember')::boolean, inputs -> 'coupon',
    (SELECT jsonb_agg(jsonb_build_object('productId', l -> 'productId', 'sellerId', l -> 'sellerId',
                                         'listPaise', l -> 'listPaise', 'freeStdDelivery', l -> 'freeStdDelivery')
                      ORDER BY o)
       FROM jsonb_array_elements(inputs -> 'lines') WITH ORDINALITY AS x(l, o)),
    inputs -> 'speedBySeller');
  IF (choices -> 'priced') IS DISTINCT FROM priced THEN
    RAISE EXCEPTION 'the quote''s amounts are not what the pricing rules give for this cart'
      USING ERRCODE = 'check_violation';
  END IF;

  rec := core.idem_begin(actor, 'checkout.create', idempotency_key, hash);
  IF rec.status IS NOT NULL THEN
    RETURN jsonb_build_object('replay', rec.response);   -- a concurrent duplicate finished first
  END IF;

  quote := jsonb_build_object(
    'version', 1,
    'lines', inputs -> 'lines',
    'speedBySeller', inputs -> 'speedBySeller',
    'coupon', inputs -> 'coupon',
    'isMember', inputs -> 'isMember',
    'addressId', inputs -> 'addressId',
    'configVersion', cfg,
    'sellers', (SELECT jsonb_agg(jsonb_build_object(
                  'sellerId', s ->> 'sellerId', 'speed', s ->> 'speed', 'listPaise', s ->> 'list',
                  'sellerDiscountPaise', s ->> 'sellerDisc', 'platformDiscountPaise', s ->> 'platformDisc',
                  'feePaise', s ->> 'fee', 'deliveryFeeBuyerPaise', s ->> 'deliveryBuyer',
                  'deliveryFeeSellerPaise', s ->> 'deliverySeller', 'netPaise', s ->> 'net',
                  'buyerPaise', ((s ->> 'list')::bigint - (s ->> 'sellerDisc')::bigint
                                 - (s ->> 'platformDisc')::bigint + (s ->> 'deliveryBuyer')::bigint)::text)
                  ORDER BY o)
                  FROM jsonb_array_elements(priced -> 'sellers') WITH ORDINALITY AS x(s, o)),
    'totalPaise', priced ->> 'total');
  INSERT INTO core.checkout_session (id, user_id, type, quote, total_paise, config_version, expires_at)
  VALUES (sid, actor, 'PRODUCT_PURCHASE', quote, (priced ->> 'total')::bigint, cfg,
          now() + make_interval(secs => core.config_int(cfg, ARRAY['checkout_session_ttl_seconds'], 300)))
  RETURNING expires_at INTO expires;
  stored := jsonb_build_object('sessionId', sid, 'expiresAt', expires, 'quote', quote);
  UPDATE core.idempotency_record r SET status = 201, response = stored
   WHERE r.user_id = actor AND r.command = 'checkout.create' AND r.key = idempotency_key;
  RETURN jsonb_build_object('result', stored);
END $$;

-- ---------------------------------------------------------------- payment attempts
-- A PENDING attempt on one of the actor's open sessions; BALANCE is authenticated at once by
-- the signed-in session itself, CARD only after its PIN step (mark_attempt_authenticated).
CREATE FUNCTION core.create_payment_attempt(session_id uuid, method text, card_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor uuid := core.actor_id();
  s     record;
  c     record;
  aid   uuid := core.uuid_v7();
  ref   text := 'DLP-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 20));
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  PERFORM ledger.require_read_committed();
  IF method IS NULL OR method NOT IN ('BALANCE', 'CARD') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'unsupported payment method');
  END IF;
  IF method = 'CARD' AND card_id IS NULL THEN
    PERFORM core.fail('VALIDATION_FAILED', 'cardId must be a uuid');
  END IF;
  IF method <> 'CARD' AND card_id IS NOT NULL THEN
    PERFORM core.fail('VALIDATION_FAILED', 'a card is only given for CARD payments');
  END IF;
  SELECT cs.state, cs.expires_at <= clock_timestamp() AS expired INTO s
    FROM core.checkout_session cs WHERE cs.id = create_payment_attempt.session_id AND cs.user_id = actor;
  IF NOT FOUND THEN
    PERFORM core.fail('NOT_FOUND', 'checkout session not found');
  END IF;
  IF s.state <> 'OPEN' THEN
    PERFORM core.fail('CONFLICT', 'checkout session is no longer open');
  END IF;
  IF s.expired THEN
    PERFORM core.fail('CHECKOUT_EXPIRED', 'checkout session has expired');
  END IF;
  IF method = 'CARD' THEN
    IF NOT core.switch_on('payments_card') THEN
      PERFORM core.fail('METHOD_UNAVAILABLE', 'card payments are switched off');
    END IF;
    SELECT vc.status, vc.merchant_scope INTO c FROM core.virtual_card vc
     WHERE vc.id = create_payment_attempt.card_id AND vc.user_id = actor;
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
  INSERT INTO core.payment_attempt (id, session_id, user_id, method, card_id, reference)
  VALUES (aid, create_payment_attempt.session_id, actor, method, create_payment_attempt.card_id, ref);
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  RETURN jsonb_build_object('attemptId', aid, 'reference', ref, 'method', method, 'authenticated', method = 'BALANCE');
END $$;

-- Marks the actor's PENDING CARD attempt authenticated (stamped by the database clock, once).
-- The PIN is still verified by the caller: this trusts the application for the PIN result
-- until PIN storage is built, when the PIN check moves into this function.
CREATE FUNCTION core.mark_attempt_authenticated(attempt_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor uuid := core.actor_id();
  a     record;
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  PERFORM ledger.require_read_committed();
  SELECT pa.state, pa.method INTO a FROM core.payment_attempt pa
   WHERE pa.id = mark_attempt_authenticated.attempt_id AND pa.user_id = actor FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM core.fail('NOT_FOUND', 'payment attempt not found');
  END IF;
  IF a.state <> 'PENDING' OR a.method <> 'CARD' THEN
    PERFORM core.fail('CONFLICT', 'only a pending card attempt can be authenticated');
  END IF;
  UPDATE core.payment_attempt pa SET authenticated_at = now() WHERE pa.id = mark_attempt_authenticated.attempt_id;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
END $$;

-- ---------------------------------------------------------------- pay (LLD §5.2)
-- The locked part of the pay transaction, run inside commit_purchase's exception block: a
-- business refusal (DM001) rolls back everything this function did, row locks included, so a
-- refused purchase leaves no business rows and holds no lock on anyone's rows.
CREATE FUNCTION core.purchase_write(actor uuid, p_session_id uuid, p_attempt_id uuid, p_order jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  ses         record;
  att         record;
  q           jsonb;
  cfg         int;
  ids         uuid[];
  sorted_ids  uuid[];
  quoted      jsonb := '{}';
  speeds_in   jsonb;
  coupon_id   uuid;
  address_id  uuid;
  pre         jsonb := '{}';
  company_ids uuid[];
  stocked_ids uuid[];
  cp          record;
  member      boolean;
  owners      jsonb := '{}';
  owner_accts jsonb := '{}';
  r           record;
  p           record;
  v           record;
  u           record;
  card        record;
  units       jsonb := '{}';
  buyer_acct  uuid;
  lines_in    jsonb := '[]';
  sellers     text[];
  sid         text;
  sp          text;
  speeds      jsonb := '{}';
  offered     boolean;
  coupon_j    jsonb;
  priced      jsonb;
  total       bigint;
  wallet_accts uuid[];
  available   bigint;
  has_ent     boolean;
  is_test     boolean;
  journal_id  uuid := core.uuid_v7();
  group_id    uuid := core.uuid_v7();
  so_ids      jsonb := '{}';
  j_created   timestamptz;
  line_id     uuid;
  pl          jsonb;
  ps          jsonb;
  d_ms        bigint;
  balance_after bigint;
  unlocked    boolean := false;
  seller_totals jsonb := '[]';
  receipt     jsonb;
  i           int;
BEGIN
  -- #1 checkout session (the buyer's own)
  SELECT cs.*, cs.expires_at <= clock_timestamp() AS expired INTO ses
    FROM core.checkout_session cs
   WHERE cs.id = p_session_id AND cs.user_id = actor AND cs.type = 'PRODUCT_PURCHASE'
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN PERFORM core.fail('NOT_FOUND', 'checkout session not found'); END IF;
  IF ses.state <> 'OPEN' THEN PERFORM core.fail('CONFLICT', 'checkout session is no longer open'); END IF;
  IF ses.expired THEN PERFORM core.fail('CHECKOUT_EXPIRED', 'checkout session has expired'); END IF;

  SELECT pa.*, pa.authenticated_at IS NOT NULL AS authenticated INTO att
    FROM core.payment_attempt pa WHERE pa.id = p_attempt_id AND pa.user_id = actor;
  IF NOT FOUND THEN PERFORM core.fail('NOT_FOUND', 'payment attempt not found'); END IF;
  IF att.session_id <> p_session_id THEN PERFORM core.fail('VALIDATION_FAILED', 'attempt belongs to another session'); END IF;
  IF att.state <> 'PENDING' THEN PERFORM core.fail('CONFLICT', 'payment attempt is no longer pending'); END IF;
  IF NOT att.authenticated THEN
    -- retryable: the client completes the challenge, then retries with the same key
    PERFORM core.fail('PAYMENT_PENDING', 'payment is awaiting authentication');
  END IF;
  IF att.method NOT IN ('BALANCE', 'CARD') THEN PERFORM core.fail('METHOD_UNAVAILABLE', 'method not offered'); END IF;
  IF att.method = 'CARD' AND NOT core.switch_on('payments_card') THEN
    PERFORM core.fail('METHOD_UNAVAILABLE', 'card payments are switched off');
  END IF;

  -- the buyer's choices are all that is taken from the stored quote
  q := ses.quote;
  IF jsonb_typeof(q -> 'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(q -> 'lines') = 0
     OR jsonb_typeof(q -> 'speedBySeller') IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(q -> 'lines') l WHERE NOT core.is_uuid(l ->> 'productId'))
     OR EXISTS (SELECT 1 FROM jsonb_each(q -> 'speedBySeller') e
                 WHERE jsonb_typeof(e.value) <> 'string' OR e.value #>> '{}' NOT IN ('STANDARD', 'EXPRESS', 'ZAP'))
     OR (COALESCE(jsonb_typeof(q -> 'coupon'), 'null') <> 'null' AND NOT core.is_uuid(q #>> '{coupon,id}'))
     OR (COALESCE(jsonb_typeof(q -> 'addressId'), 'null') <> 'null' AND NOT core.is_uuid(q ->> 'addressId')) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'the checkout session''s choices cannot be read');
  END IF;
  ids := ARRAY(SELECT (l ->> 'productId')::uuid FROM jsonb_array_elements(q -> 'lines') WITH ORDINALITY AS x(l, o) ORDER BY o);
  IF (SELECT count(DISTINCT i2) FROM unnest(ids) i2) <> cardinality(ids) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'the checkout session''s choices cannot be read');
  END IF;
  SELECT COALESCE(jsonb_object_agg(l ->> 'productId', l ->> 'productVersionId'), '{}') INTO quoted
    FROM jsonb_array_elements(q -> 'lines') l WHERE jsonb_typeof(l -> 'productVersionId') = 'string';
  speeds_in := q -> 'speedBySeller';
  IF COALESCE(jsonb_typeof(q -> 'coupon'), 'null') <> 'null' THEN coupon_id := (q #>> '{coupon,id}')::uuid; END IF;
  IF COALESCE(jsonb_typeof(q -> 'addressId'), 'null') <> 'null' THEN address_id := (q ->> 'addressId')::uuid; END IF;
  cfg := ses.config_version;
  IF cardinality(ids) > core.config_int(cfg, ARRAY['cart_max_lines'], 20) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'too many lines');
  END IF;
  sorted_ids := ARRAY(SELECT x FROM unnest(ids) x ORDER BY x);

  -- sellers and inventory modes as currently recorded (re-checked once the rows are locked)
  FOR r IN SELECT pr.id, pr.company_id, pr.inventory_mode FROM core.product pr WHERE pr.id = ANY(ids) LOOP
    pre := pre || jsonb_build_object(r.id::text, jsonb_build_object('company', r.company_id, 'mode', r.inventory_mode));
  END LOOP;
  company_ids := ARRAY(SELECT DISTINCT (e.value ->> 'company')::uuid FROM jsonb_each(pre) e
                        WHERE e.value ->> 'company' IS NOT NULL ORDER BY 1);
  stocked_ids := ARRAY(SELECT e.key::uuid FROM jsonb_each(pre) e
                        WHERE e.value ->> 'mode' IN ('STANDARD_STOCKED', 'EXCLUSIVE'));

  -- #2 coupon: its terms come from this locked row only
  IF coupon_id IS NOT NULL THEN
    PERFORM 1 FROM core.coupon c WHERE c.id = coupon_id FOR NO KEY UPDATE;
  END IF;
  -- #3 membership (read: pay never changes it)
  member := EXISTS (SELECT 1 FROM core.membership m
                     WHERE m.user_id = actor AND m.starts_at <= clock_timestamp() AND m.ends_at > clock_timestamp());
  -- #4 selling companies, ascending id; shared: purchases from one seller do not queue on each other
  FOR r IN SELECT c.id, c.owner_user_id FROM core.company c WHERE c.id = ANY(company_ids) ORDER BY c.id FOR SHARE LOOP
    owners := owners || jsonb_build_object(r.id::text, r.owner_user_id);
  END LOOP;
  FOR r IN SELECT la.id, la.user_id FROM ledger.ledger_account la
            WHERE la.type = 'USER' AND la.user_id IN (SELECT (e.value #>> '{}')::uuid FROM jsonb_each(owners) e) LOOP
    owner_accts := owner_accts || jsonb_build_object(r.user_id::text, r.id);
  END LOOP;
  -- #5 warehouses holding available units of the stocked products
  PERFORM 1 FROM core.warehouse w
   WHERE w.id IN (SELECT un.warehouse_id FROM core.inventory_unit un
                   WHERE un.product_id = ANY(stocked_ids) AND un.state = 'AVAILABLE')
   ORDER BY w.id FOR NO KEY UPDATE;
  -- #6 products, ascending id: stocked ones exclusively (their counter changes), unlimited seed
  -- stock shared (nothing on it changes)
  FOREACH line_id IN ARRAY sorted_ids LOOP
    IF pre -> line_id::text ->> 'mode' IN ('STANDARD_STOCKED', 'EXCLUSIVE') THEN
      PERFORM 1 FROM core.product pr WHERE pr.id = line_id FOR NO KEY UPDATE;
    ELSE
      PERFORM 1 FROM core.product pr WHERE pr.id = line_id FOR SHARE;
    END IF;
  END LOOP;
  -- #7 inventory units: lowest AVAILABLE serial per stocked product, ascending product id; Zap
  -- from a user company ships only from a Zap hub warehouse
  FOREACH line_id IN ARRAY sorted_ids LOOP
    SELECT pr.status, pr.company_id, pr.inventory_mode INTO p FROM core.product pr WHERE pr.id = line_id;
    CONTINUE WHEN NOT FOUND OR p.status <> 'PUBLISHED' OR p.inventory_mode NOT IN ('STANDARD_STOCKED', 'EXCLUSIVE');
    SELECT un.id, un.warehouse_id, un.serial, w.zap_hub INTO u
      FROM core.inventory_unit un JOIN core.warehouse w ON w.id = un.warehouse_id
     WHERE un.product_id = line_id AND un.state = 'AVAILABLE'
       AND (p.company_id IS NULL OR speeds_in ->> p.company_id::text IS DISTINCT FROM 'ZAP' OR w.zap_hub)
     ORDER BY un.serial NULLS LAST, un.id LIMIT 1
     FOR NO KEY UPDATE OF un;
    IF FOUND THEN
      units := units || jsonb_build_object(line_id::text, jsonb_build_object(
        'id', u.id, 'warehouse', u.warehouse_id, 'serial', u.serial, 'hub', u.zap_hub));
    END IF;
  END LOOP;
  -- #8 card: the buyer's own
  IF att.method = 'CARD' THEN
    SELECT vc.status, vc.merchant_scope INTO card FROM core.virtual_card vc
     WHERE vc.id = att.card_id AND vc.user_id = actor FOR NO KEY UPDATE;
    IF NOT FOUND THEN PERFORM core.fail('CARD_NOT_OWNED', 'card not found for this user');
    ELSIF card.status = 'FROZEN' THEN PERFORM core.fail('CARD_FROZEN', 'card is frozen');
    ELSIF card.status <> 'ACTIVE' THEN PERFORM core.fail('CARD_REPLACED', 'card has been replaced');
    ELSIF card.merchant_scope <> 'DELULUMART' THEN PERFORM core.fail('MERCHANT_NOT_ALLOWED', 'card cannot be used here');
    END IF;
  END IF;
  SELECT la.id INTO buyer_acct FROM ledger.ledger_account la WHERE la.user_id = actor AND la.type = 'USER';
  IF buyer_acct IS NULL THEN PERFORM core.fail('FORBIDDEN', 'buyer has no ledger account'); END IF;

  -- re-validate every line against the locked rows, in pricing order
  FOR i IN 1 .. cardinality(ids) LOOP
    IF EXISTS (SELECT 1 FROM core.ownership o WHERE o.user_id = actor AND o.product_id = ids[i]) THEN
      PERFORM core.fail('ALREADY_OWNED', 'you already own this product');
    END IF;
    SELECT pr.* INTO p FROM core.product pr WHERE pr.id = ids[i];
    IF NOT FOUND OR p.status <> 'PUBLISHED' THEN
      PERFORM core.fail('PRODUCT_UNAVAILABLE', 'a product is no longer available');
    END IF;
    SELECT pv.* INTO v FROM core.product_version pv WHERE pv.id = p.current_version_id;
    IF NOT FOUND OR v.product_id <> p.id OR (quoted ? p.id::text AND quoted ->> p.id::text IS DISTINCT FROM v.id::text)
       OR (pre -> p.id::text ->> 'company') IS DISTINCT FROM p.company_id::text
       OR (pre -> p.id::text ->> 'mode') IS DISTINCT FROM p.inventory_mode THEN
      PERFORM core.fail('CART_CHANGED', 'a product changed since the quote');
    END IF;
    IF p.company_id IS NOT NULL THEN
      IF NOT (owners ? p.company_id::text) OR NOT (owner_accts ? (owners ->> p.company_id::text)) THEN
        PERFORM core.fail('PRODUCT_UNAVAILABLE', 'the seller is not available');
      END IF;
      IF owners ->> p.company_id::text = actor::text THEN
        PERFORM core.fail('SELF_PURCHASE', 'you cannot buy from your own company');
      END IF;
    END IF;
    IF p.inventory_mode IN ('STANDARD_STOCKED', 'EXCLUSIVE') AND (p.available_units <= 0 OR NOT (units ? p.id::text)) THEN
      IF p.available_units > 0 AND p.company_id IS NOT NULL AND speeds_in ->> p.company_id::text = 'ZAP' THEN
        PERFORM core.fail('DELIVERY_UNAVAILABLE', 'no unit in a Zap hub');
      END IF;
      PERFORM core.fail('SOLD_OUT', 'a product sold out');
    END IF;
    lines_in := lines_in || jsonb_build_array(jsonb_build_object(
      'productId', p.id, 'sellerId', COALESCE(p.company_id::text, 'SEED'), 'listPaise', v.price_paise::text,
      'freeStdDelivery', p.free_standard_delivery));
  END LOOP;

  -- delivery: the buyer chose a speed per seller; eligibility comes from the locked rows
  sellers := ARRAY(SELECT l ->> 'sellerId' FROM jsonb_array_elements(lines_in) WITH ORDINALITY AS x(l, o)
                    GROUP BY l ->> 'sellerId' ORDER BY min(o));
  FOREACH sid IN ARRAY sellers LOOP
    sp := speeds_in ->> sid;
    IF sp IS NULL THEN PERFORM core.fail('CART_CHANGED', 'the sellers changed since the quote'); END IF;
    SELECT CASE sp
             WHEN 'STANDARD' THEN true
             WHEN 'EXPRESS' THEN bool_and(pr.offers_express)
             ELSE CASE WHEN sid = 'SEED' THEN bool_and(pr.zap_flag)
                       ELSE bool_and(COALESCE((units -> pr.id::text ->> 'hub')::boolean, false)) END
           END
      INTO offered
      FROM core.product pr WHERE pr.id = ANY(ids) AND COALESCE(pr.company_id::text, 'SEED') = sid;
    IF NOT offered THEN PERFORM core.fail('DELIVERY_UNAVAILABLE', 'that delivery speed is not offered'); END IF;
    speeds := speeds || jsonb_build_object(sid, sp);
  END LOOP;

  IF coupon_id IS NOT NULL THEN
    DECLARE
      problem text[] := core.coupon_problem(coupon_id, actor, owners);
    BEGIN
      IF problem IS NOT NULL THEN PERFORM core.fail(problem[1], problem[2]); END IF;
    END;
    SELECT c.* INTO cp FROM core.coupon c WHERE c.id = coupon_id;
    coupon_j := jsonb_build_object('companyId', cp.company_id, 'kind', cp.kind, 'value', cp.value::text,
                                   'minSpendPaise', cp.min_spend_paise::text);
  END IF;
  IF address_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM private.address a WHERE a.id = address_id AND a.user_id = actor) THEN
    address_id := NULL;   -- removed since the quote; the shipment keeps no address
  END IF;

  -- every amount, re-derived from the locked rows
  priced := core.price_cart(cfg, member, coupon_j, lines_in, speeds);
  total := (priced ->> 'total')::bigint;
  IF total <> ses.total_paise THEN PERFORM core.fail('CART_CHANGED', 'the total changed since the quote'); END IF;
  -- the caller's amounts (from the pricing function) must be exactly these; a stale read on the
  -- caller's side is retryable (40001 -> BUSY), never stored
  IF p_order IS DISTINCT FROM priced THEN
    RAISE EXCEPTION 'the priced order does not match the locked rows; retry with the same idempotency key'
      USING ERRCODE = 'serialization_failure';
  END IF;

  -- #9 wallets: buyer and every seller, ascending account id (ledger.sync_wallets waits at most
  -- 2 s). Taken last: a refused purchase never queues on (or holds) anyone's wallet.
  wallet_accts := ARRAY(SELECT DISTINCT x FROM unnest(
                    ARRAY[buyer_acct] || ARRAY(SELECT (owner_accts ->> (owners ->> (s ->> 'sellerId')))::uuid
                                                 FROM jsonb_array_elements(priced -> 'sellers') s
                                                WHERE s ->> 'sellerId' <> 'SEED')) x ORDER BY x);
  PERFORM ledger.sync_wallets(wallet_accts);
  SELECT w.available_paise INTO available FROM ledger.wallet w WHERE w.account_id = buyer_acct;
  -- #10 entitlement (read under the buyer's wallet lock)
  has_ent := EXISTS (SELECT 1 FROM core.creator_entitlement ce WHERE ce.user_id = actor);
  IF COALESCE(available, 0) < total THEN PERFORM core.fail('INSUFFICIENT_FUNDS', 'not enough fictional balance'); END IF;

  -- ------------------------------------------------ writes
  SET CONSTRAINTS ALL DEFERRED;   -- whatever mode the caller left: the checks run below, synchronously
  INSERT INTO ledger.journal (id, event_type, config_version, order_group_id, idempotency_ref)
  VALUES (journal_id, 'PURCHASE', cfg, group_id, p_attempt_id);
  FOR ps IN SELECT s FROM jsonb_array_elements(priced -> 'sellers') s LOOP
    so_ids := so_ids || jsonb_build_object(ps ->> 'sellerId', core.uuid_v7());
  END LOOP;
  INSERT INTO ledger.posting (journal_id, account_id, amount, seller_order_id, memo)
  SELECT journal_id,
         CASE x ->> 'account'
           WHEN 'BUYER' THEN buyer_acct
           WHEN 'SINK' THEN '00000000-0000-7000-8000-000000000002'::uuid
           ELSE (owner_accts ->> (owners ->> (x ->> 'account')))::uuid END,
         (x ->> 'amount')::bigint,
         CASE WHEN x ->> 'account' IN ('BUYER', 'SINK') THEN NULL ELSE (so_ids ->> (x ->> 'account'))::uuid END,
         CASE x ->> 'account' WHEN 'BUYER' THEN 'Purchase' WHEN 'SINK' THEN 'Fees, delivery and seed sales'
                              ELSE 'Sale proceeds' END
    FROM jsonb_array_elements(priced -> 'postings') WITH ORDINALITY AS t(x, o) ORDER BY o;
  SELECT j.created_at INTO j_created FROM ledger.journal j WHERE j.id = journal_id;

  SELECT up.is_test_account INTO is_test FROM core.user_profile up WHERE up.id = actor;
  is_test := COALESCE(is_test, false);
  INSERT INTO core.order_group (id, buyer_user_id, session_id, payment_attempt_id, journal_id, buyer_source,
                                total_paise, config_version)
  VALUES (group_id, actor, p_session_id, p_attempt_id, journal_id, CASE WHEN is_test THEN 'STAFF' ELSE 'PLAYER' END,
          total, cfg);
  FOR ps IN SELECT s FROM jsonb_array_elements(priced -> 'sellers') WITH ORDINALITY AS t(s, o) ORDER BY o LOOP
    INSERT INTO core.seller_order (id, order_group_id, buyer_user_id, company_id, seller_type, list_paise,
      seller_discount_paise, platform_discount_paise, fee_paise, delivery_fee_buyer_paise, delivery_fee_seller_paise,
      net_paise, qualifies_for_progression)
    VALUES ((so_ids ->> (ps ->> 'sellerId'))::uuid, group_id, actor,
            CASE WHEN ps ->> 'sellerId' = 'SEED' THEN NULL ELSE (ps ->> 'sellerId')::uuid END,
            CASE WHEN ps ->> 'sellerId' = 'SEED' THEN 'SEED' ELSE 'USER' END,
            (ps ->> 'list')::bigint, (ps ->> 'sellerDisc')::bigint, (ps ->> 'platformDisc')::bigint, (ps ->> 'fee')::bigint,
            (ps ->> 'deliveryBuyer')::bigint, (ps ->> 'deliverySeller')::bigint, (ps ->> 'net')::bigint,
            NOT is_test);   -- a test account's purchase never counts towards a seller's progression
    seller_totals := seller_totals || jsonb_build_array(jsonb_build_object(
      'sellerId', ps ->> 'sellerId', 'sellerOrderId', so_ids ->> (ps ->> 'sellerId'),
      'totalPaise', ((ps ->> 'list')::bigint - (ps ->> 'sellerDisc')::bigint - (ps ->> 'platformDisc')::bigint
                     + (ps ->> 'deliveryBuyer')::bigint)::text));
  END LOOP;

  FOR i IN 1 .. cardinality(ids) LOOP
    pl := priced -> 'lines' -> (i - 1);
    SELECT pr.* INTO p FROM core.product pr WHERE pr.id = ids[i];
    SELECT pv.* INTO v FROM core.product_version pv WHERE pv.id = p.current_version_id;
    line_id := core.uuid_v7();
    INSERT INTO core.order_line (id, seller_order_id, product_id, product_version_id, snapshot, list_paise,
      seller_discount_paise, platform_discount_paise, fee_paise, inventory_unit_id, edition_serial, line_no)
    VALUES (line_id, (so_ids ->> (pl ->> 'sellerId'))::uuid, p.id, v.id,
            jsonb_build_object('productVersionId', v.id, 'revision', v.revision, 'name', v.name,
                               'templateId', v.template_id, 'listPaise', v.price_paise::text,
                               'sellerType', CASE WHEN p.company_id IS NULL THEN 'SEED' ELSE 'USER' END,
                               'companyId', p.company_id, 'inventoryMode', p.inventory_mode),
            (pl ->> 'listPaise')::bigint, (pl ->> 'sellerDisc')::bigint, (pl ->> 'platformDisc')::bigint,
            (pl ->> 'fee')::bigint, (units -> p.id::text ->> 'id')::uuid,
            CASE WHEN p.inventory_mode = 'EXCLUSIVE' THEN (units -> p.id::text ->> 'serial')::int END,
            i - 1);
    INSERT INTO core.ownership (id, user_id, product_id, order_line_id) VALUES (core.uuid_v7(), actor, p.id, line_id);
    IF units ? p.id::text THEN
      UPDATE core.inventory_unit SET state = 'ISSUED', order_line_id = line_id WHERE id = (units -> p.id::text ->> 'id')::uuid;
      UPDATE core.product SET available_units = available_units - 1 WHERE id = p.id;
      UPDATE core.warehouse SET used = used - 1 WHERE id = (units -> p.id::text ->> 'warehouse')::uuid;
      -- core.stock_movement does not exist yet; when it is created, record the ISSUE here.
    END IF;
  END LOOP;

  IF coupon_id IS NOT NULL THEN
    UPDATE core.coupon SET redeemed = redeemed + 1 WHERE id = coupon_id;
    INSERT INTO core.coupon_redemption (coupon_id, user_id, order_group_id, discount_paise)
    SELECT coupon_id, actor, group_id, COALESCE(SUM((s ->> 'sellerDisc')::bigint), 0)
      FROM jsonb_array_elements(priced -> 'sellers') s WHERE s ->> 'sellerId' = cp.company_id::text;
  END IF;

  -- shipments: placed at the journal's time (database clock), then 10/30/70/100% of the duration
  FOR ps IN SELECT s FROM jsonb_array_elements(priced -> 'sellers') s LOOP
    d_ms := core.config_int(cfg, ARRAY['delivery_duration_ms', ps ->> 'speed'],
                            CASE ps ->> 'speed' WHEN 'STANDARD' THEN 86400000 WHEN 'EXPRESS' THEN 7200000 ELSE 600000 END);
    INSERT INTO core.shipment (id, seller_order_id, speed, address_id, placed_at, packed_at, shipped_at, out_at, delivered_at)
    VALUES (core.uuid_v7(), (so_ids ->> (ps ->> 'sellerId'))::uuid, ps ->> 'speed', address_id, j_created,
            j_created + (d_ms * 10 / 100) * interval '1 millisecond',
            j_created + (d_ms * 30 / 100) * interval '1 millisecond',
            j_created + (d_ms * 70 / 100) * interval '1 millisecond',
            j_created + d_ms * interval '1 millisecond');
  END LOOP;

  -- wallets follow the postings (CHECK available_paise >= 0 is the last line of defence)
  PERFORM ledger.sync_wallets(wallet_accts);
  SELECT w.available_paise INTO balance_after FROM ledger.wallet w WHERE w.account_id = buyer_acct;
  IF balance_after IS DISTINCT FROM available - total THEN
    RAISE EXCEPTION 'pay: the buyer wallet did not follow the postings' USING ERRCODE = 'internal_error';
  END IF;
  IF NOT has_ent AND balance_after < core.config_paise(cfg, ARRAY['creator_threshold_paise'], 1000000000) THEN
    INSERT INTO core.creator_entitlement (id, user_id, source, evidence_order_group_id)
    VALUES (core.uuid_v7(), actor, 'PURCHASE_THRESHOLD', group_id) ON CONFLICT (user_id) DO NOTHING;
    unlocked := FOUND;
  END IF;

  UPDATE core.payment_attempt SET state = 'SUCCEEDED' WHERE id = p_attempt_id;
  UPDATE core.checkout_session SET state = 'SUCCEEDED' WHERE id = p_session_id;

  -- ids and amounts only: no personal data and no sign-in session id (invariant 8)
  INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
  VALUES (core.uuid_v7(), 'purchase_completed', group_id, jsonb_build_object(
    'orderGroupId', group_id, 'journalId', journal_id, 'checkoutSessionId', p_session_id,
    'paymentAttemptId', p_attempt_id, 'buyerUserId', actor, 'configVersion', cfg, 'totalPaise', total::text,
    'sellerOrders', seller_totals, 'productIds', to_jsonb(sorted_ids), 'creatorUnlocked', unlocked), 1);

  -- every structural check of 0003/0014/0016, now; this seals the journal and order group (R9)
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;

  receipt := jsonb_build_object('orderGroupId', group_id, 'paymentReference', att.reference,
    'sellers', seller_totals, 'totalPaise', total::text, 'balanceAfterPaise', balance_after::text,
    'creatorUnlocked', unlocked);
  RETURN receipt;
END $$;

-- The pay transaction. Returns {status: 'SUCCEEDED', receipt, replayed, reversed} or
-- {status: 'FAILED', error: {code, message}, replayed}. A business refusal records the attempt
-- FAILED and the refusal under the idempotency key, with no business rows and no locks left on
-- other users' rows. Retryable conditions (busy, awaiting authentication, switched off, a key
-- reused for another request) raise and record nothing.
CREATE FUNCTION core.commit_purchase(session_id uuid, attempt_id uuid, idempotency_key text, request_hash bytea,
                                     "order" jsonb) RETURNS jsonb
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

  -- 1. idempotency
  rec := core.idem_begin(actor, 'pay', idempotency_key, request_hash);
  IF rec.status = 200 THEN
    RETURN jsonb_build_object('status', 'SUCCEEDED', 'replayed', true, 'receipt', rec.response,
      'reversed', EXISTS (SELECT 1 FROM core.seller_order so
                           WHERE so.order_group_id = (rec.response ->> 'orderGroupId')::uuid AND so.status = 'REVERSED'));
  ELSIF rec.status IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'FAILED', 'replayed', true, 'error', rec.response -> 'error');
  END IF;

  -- 2. switches, read inside the transaction; missing or off refuses
  IF NOT core.switch_on('purchases') THEN
    PERFORM core.fail('MAINTENANCE', 'purchases are switched off');
  END IF;

  -- 3-5. locks, validation, writes, checks
  BEGIN
    receipt := core.purchase_write(actor, commit_purchase.session_id, commit_purchase.attempt_id, "order");
    UPDATE core.idempotency_record r SET status = 200, response = receipt
     WHERE r.user_id = actor AND r.command = 'pay' AND r.key = idempotency_key;
    RETURN jsonb_build_object('status', 'SUCCEEDED', 'replayed', false, 'receipt', receipt, 'reversed', false);
  EXCEPTION WHEN SQLSTATE 'DM001' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT, code = PG_EXCEPTION_HINT;
    IF code = 'PAYMENT_PENDING' THEN
      RAISE;   -- retryable once the challenge is complete
    END IF;
  END;
  -- a validation failure: nothing of the purchase remains; record it
  UPDATE core.idempotency_record r
     SET status = 422, response = jsonb_build_object('error', jsonb_build_object('code', code, 'message', msg))
   WHERE r.user_id = actor AND r.command = 'pay' AND r.key = idempotency_key;
  UPDATE core.payment_attempt pa SET state = 'FAILED', failure_code = code
   WHERE pa.id = commit_purchase.attempt_id AND pa.session_id = commit_purchase.session_id
     AND pa.user_id = actor AND pa.state = 'PENDING';
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  RETURN jsonb_build_object('status', 'FAILED', 'replayed', false,
                            'error', jsonb_build_object('code', code, 'message', msg));
END $$;

-- ---------------------------------------------------------------- privileges
-- New functions are not executable by PUBLIC (default privileges), and nothing created here or
-- earlier is executable by anyone but the roles named below and in 0011/0012.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA core, ledger, private, sandbox, analytics, audit, research FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  core.provision_account(bytea, bytea, text, text, text),
  core.checkout_inputs(jsonb, text),
  core.create_checkout_session(jsonb, text),
  core.create_payment_attempt(uuid, text, uuid),
  core.mark_attempt_authenticated(uuid),
  core.commit_purchase(uuid, uuid, text, bytea, jsonb)
TO app_pay;
GRANT EXECUTE ON FUNCTION core.purge_idempotency_records() TO app_jobs;
