-- PRD R5.2 delivery addresses, architecture §15.5, LLD §3.1 (private.address) and §5.6.
--
-- What a player saves is AES-256-GCM ciphertext made by the web deployment with FIELD_KEY (key id
-- prefixed, bound to "address:<user id>"): THE DATABASE NEVER SEES A PLAIN ADDRESS. No plaintext
-- part of an address (state, PIN code or a prefix of it) is stored either: R5.2 says delivery
-- promises, fees and Zap eligibility do not depend on the address, so no feature needs to read it.
--
--  1. private.address gains is_default (one per player: partial unique index) and updated_at. The
--     direct table privileges of 0011 are revoked from every application role: the address book is
--     reached only through the owner-run definer commands below (actor from core.actor_id()):
--       core.my_addresses(), core.address_create(label, payload_enc, make_default),
--       core.address_update(id, label, payload_enc), core.address_delete(id),
--       core.address_set_default(id)                                            (app_web)
--     At most `address_max_per_user` (configuration, default 5, R5.2) per player, counted under a
--     row lock on the player's profile (LLD §3.1). Deleting is real (R5.2, architecture §15.5): the
--     row goes and the default moves to the most recent remaining address.
--  2. core.checkout_destination: where an OPEN product checkout session delivers when the player
--     changes it after the quote (core.checkout_set_destination, app_pay): one of the actor's own
--     REAL addresses, or the fictional delivery spot. With no row the quote's addressId applies, and
--     with neither the fictional spot, the pre-selected default (decisions.md #4). The address is
--     not part of pricing, so the immutable quote is untouched (invariant 3).
--     core.checkout_address_check(id) (app_pay) answers ADDRESS_NOT_FOUND for anything but one of
--     the actor's own addresses before a session is created with an addressId.
--  3. private.order_delivery: the order group's destination, written inside the pay transaction
--     (core.commit_purchase, below) after every lock of the canonical order (LLD §4: the buyer's
--     own address row is taken FOR KEY SHARE as a new last class, #11, so a concurrent delete waits
--     for the payment and then erases its copy). It holds a copy of the ciphertext and the label
--     so that a later EDIT does not change a past order, and it is immutable except for erasure:
--     DELETING the address (any path, including a cascade from the profile) erases every copy, and
--     the order keeps only "Address removed" (R5.2). The shipments reference the address by id
--     (0006, ON DELETE SET NULL). core.my_order_delivery(group) (app_web) answers the buyer only.
--
-- Sellers, jobs, analytics, the outbox and the audit log never receive any of it: no seller read
-- (0042/0051/0055) joins these tables, and nothing here writes an event.

-- ---------------------------------------------------------------- 1. the address book
ALTER TABLE private.address
  ADD COLUMN is_default boolean NOT NULL DEFAULT false,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX address_one_default ON private.address (user_id) WHERE is_default;

REVOKE ALL ON private.address FROM PUBLIC, app_web, app_pay, app_jobs, npc_worker, research_ro;

-- ---------------------------------------------------------------- 2. checkout destination
CREATE TABLE core.checkout_destination (
  session_id uuid PRIMARY KEY REFERENCES core.checkout_session (id),
  user_id    uuid NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('FICTIONAL_SPOT', 'ADDRESS')),
  -- NULL for ADDRESS once that address is deleted: the payment is then refused (ADDRESS_NOT_FOUND)
  address_id uuid REFERENCES private.address (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'ADDRESS' OR address_id IS NULL)
);
CREATE INDEX checkout_destination_address ON core.checkout_destination (address_id) WHERE address_id IS NOT NULL;
ALTER TABLE core.checkout_destination ENABLE ROW LEVEL SECURITY;
-- a backstop only: no application role holds a privilege on the table
CREATE POLICY owner_only ON core.checkout_destination FOR SELECT TO app_pay USING (user_id = core.actor_id());
REVOKE ALL ON core.checkout_destination FROM PUBLIC, app_web, app_pay, app_jobs, npc_worker, research_ro;

-- ---------------------------------------------------------------- 3. the order's destination
CREATE TABLE private.order_delivery (
  order_group_id uuid PRIMARY KEY REFERENCES core.order_group (id),
  user_id        uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('FICTIONAL_SPOT', 'ADDRESS')),
  address_id     uuid REFERENCES private.address (id) ON DELETE SET NULL,
  label          text CHECK (label IN ('HOME', 'WORK', 'OTHER')),
  payload_enc    bytea,
  removed_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'FICTIONAL_SPOT' AND address_id IS NULL AND label IS NULL AND payload_enc IS NULL AND removed_at IS NULL)
    OR (kind = 'ADDRESS' AND payload_enc IS NOT NULL AND label IS NOT NULL AND removed_at IS NULL)
    OR (kind = 'ADDRESS' AND payload_enc IS NULL AND label IS NULL AND address_id IS NULL AND removed_at IS NOT NULL)
  )
);
CREATE INDEX order_delivery_address ON private.order_delivery (address_id) WHERE address_id IS NOT NULL;
ALTER TABLE private.order_delivery ENABLE ROW LEVEL SECURITY;
-- a backstop only: no application role holds a privilege on the table
CREATE POLICY owner_only ON private.order_delivery FOR SELECT TO app_web USING (user_id = core.actor_id());
REVOKE ALL ON private.order_delivery FROM PUBLIC, app_web, app_pay, app_jobs, npc_worker, research_ro;

-- Immutable except for erasure (copy → "Address removed"); never deleted.
CREATE FUNCTION core.guard_order_delivery() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an order''s delivery record is never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.kind = 'ADDRESS' AND OLD.payload_enc IS NOT NULL
     AND NEW.payload_enc IS NULL AND NEW.label IS NULL AND NEW.address_id IS NULL AND NEW.removed_at IS NOT NULL
     AND (NEW.order_group_id, NEW.user_id, NEW.kind, NEW.created_at)
         IS NOT DISTINCT FROM (OLD.order_group_id, OLD.user_id, OLD.kind, OLD.created_at) THEN
    RETURN NEW;   -- erasure
  END IF;
  IF to_jsonb(NEW) IS NOT DISTINCT FROM to_jsonb(OLD) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'an order''s delivery record is immutable except for erasure' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER guard BEFORE UPDATE OR DELETE ON private.order_delivery
  FOR EACH ROW EXECUTE FUNCTION core.guard_order_delivery();

-- Deleting an address, by whatever path, erases every order copy first (before the foreign keys'
-- SET NULL could detach them) and points open checkout destinations at nothing.
CREATE FUNCTION core.erase_address_copies() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE private.order_delivery od
     SET payload_enc = NULL, label = NULL, address_id = NULL, removed_at = clock_timestamp()
   WHERE od.address_id = OLD.id AND od.payload_enc IS NOT NULL;
  UPDATE core.checkout_destination d SET address_id = NULL, updated_at = clock_timestamp()
   WHERE d.address_id = OLD.id;
  RETURN OLD;
END $$;
CREATE TRIGGER erase_copies BEFORE DELETE ON private.address
  FOR EACH ROW EXECUTE FUNCTION core.erase_address_copies();

-- ---------------------------------------------------------------- commands
CREATE FUNCTION core.address_json(a private.address) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('id', a.id, 'label', a.label, 'isDefault', a.is_default,
                            'payloadEnc', encode(a.payload_enc, 'base64'),
                            'createdAt', a.created_at, 'updatedAt', a.updated_at)
$$;

-- The signed-in actor, with their profile row locked: the address commands of one player serialise.
CREATE FUNCTION core.address_actor() RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := core.actor_id();
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  PERFORM 1 FROM core.user_profile p WHERE p.id = actor FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM core.fail('ONBOARDING_REQUIRED', 'finish setting up your account first');
  END IF;
  RETURN actor;
END $$;

CREATE FUNCTION core.address_check_input(p_label text, p_payload_enc bytea, p_required boolean) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (p_label IS NULL AND p_required) OR (p_label IS NOT NULL AND p_label NOT IN ('HOME', 'WORK', 'OTHER')) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'label is HOME, WORK or OTHER');
  END IF;
  -- keyId (1) ‖ nonce (12) ‖ ciphertext ‖ tag (16); 4 KiB at most
  IF (p_payload_enc IS NULL AND p_required)
     OR (p_payload_enc IS NOT NULL AND octet_length(p_payload_enc) NOT BETWEEN 29 AND 4096) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'an encrypted address is required');
  END IF;
END $$;

CREATE FUNCTION core.my_addresses() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := core.actor_id();
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  RETURN COALESCE((SELECT jsonb_agg(core.address_json(a) ORDER BY a.is_default DESC, a.created_at DESC, a.id DESC)
                     FROM private.address a WHERE a.user_id = actor AND a.kind = 'REAL'), '[]'::jsonb);
END $$;

CREATE FUNCTION core.address_create(p_label text, p_payload_enc bytea, p_make_default boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor uuid;
  n     bigint;
  row_  private.address;
BEGIN
  PERFORM core.address_check_input(p_label, p_payload_enc, true);
  actor := core.address_actor();
  SELECT count(*) INTO n FROM private.address a WHERE a.user_id = actor AND a.kind = 'REAL';
  IF n >= core.config_int(core.current_config_id(), ARRAY['address_max_per_user'], 5) THEN
    PERFORM core.fail('ADDRESS_LIMIT', 'you already have the most saved addresses allowed');
  END IF;
  IF COALESCE(p_make_default, false) THEN
    UPDATE private.address a SET is_default = false WHERE a.user_id = actor AND a.is_default;
  END IF;
  INSERT INTO private.address (id, user_id, kind, label, payload_enc, is_default)
  VALUES (core.uuid_v7(), actor, 'REAL', p_label, p_payload_enc,
          COALESCE(p_make_default, false)
          OR NOT EXISTS (SELECT 1 FROM private.address a WHERE a.user_id = actor AND a.is_default))
  RETURNING * INTO row_;
  RETURN core.address_json(row_);
END $$;

CREATE FUNCTION core.address_update(p_id uuid, p_label text, p_payload_enc bytea) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor uuid;
  row_  private.address;
BEGIN
  PERFORM core.address_check_input(p_label, p_payload_enc, false);
  IF p_label IS NULL AND p_payload_enc IS NULL THEN
    PERFORM core.fail('VALIDATION_FAILED', 'nothing to change');
  END IF;
  actor := core.address_actor();
  UPDATE private.address a
     SET label = COALESCE(p_label, a.label), payload_enc = COALESCE(p_payload_enc, a.payload_enc),
         updated_at = clock_timestamp()
   WHERE a.id = p_id AND a.user_id = actor AND a.kind = 'REAL'
  RETURNING * INTO row_;
  IF NOT FOUND THEN
    PERFORM core.fail('ADDRESS_NOT_FOUND', 'address not found');
  END IF;
  RETURN core.address_json(row_);
END $$;

CREATE FUNCTION core.address_delete(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor      uuid;
  was_default boolean;
  promoted   uuid;
BEGIN
  actor := core.address_actor();
  SELECT a.is_default INTO was_default FROM private.address a
   WHERE a.id = p_id AND a.user_id = actor AND a.kind = 'REAL' FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM core.fail('ADDRESS_NOT_FOUND', 'address not found');
  END IF;
  DELETE FROM private.address a WHERE a.id = p_id;   -- erase_copies empties every order copy first
  IF was_default THEN
    UPDATE private.address a SET is_default = true
     WHERE a.id = (SELECT r.id FROM private.address r WHERE r.user_id = actor AND r.kind = 'REAL'
                    ORDER BY r.created_at DESC, r.id DESC LIMIT 1)
    RETURNING a.id INTO promoted;
  ELSE
    SELECT a.id INTO promoted FROM private.address a WHERE a.user_id = actor AND a.is_default;
  END IF;
  RETURN jsonb_build_object('deletedId', p_id, 'defaultAddressId', promoted);
END $$;

CREATE FUNCTION core.address_set_default(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor uuid;
  row_  private.address;
BEGIN
  actor := core.address_actor();
  PERFORM 1 FROM private.address a WHERE a.id = p_id AND a.user_id = actor AND a.kind = 'REAL' FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM core.fail('ADDRESS_NOT_FOUND', 'address not found');
  END IF;
  -- two statements: a unique index is checked row by row
  UPDATE private.address a SET is_default = false WHERE a.user_id = actor AND a.is_default AND a.id <> p_id;
  UPDATE private.address a SET is_default = true WHERE a.id = p_id RETURNING * INTO row_;
  RETURN core.address_json(row_);
END $$;

-- ---------------------------------------------------------------- checkout
CREATE FUNCTION core.checkout_address_check(p_address uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := core.actor_id();
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  IF p_address IS NULL OR NOT EXISTS (SELECT 1 FROM private.address a
                                       WHERE a.id = p_address AND a.user_id = actor AND a.kind = 'REAL') THEN
    PERFORM core.fail('ADDRESS_NOT_FOUND', 'address not found');
  END IF;
END $$;

-- Sets where the actor's OPEN product checkout session delivers: p_address NULL is the fictional
-- spot. Takes the session row first (#1 of LLD §4, as pay does), so it cannot change mid-payment.
CREATE FUNCTION core.checkout_set_destination(p_session uuid, p_address uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor uuid := core.actor_id();
  ses   record;
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  SELECT cs.state, cs.expires_at <= clock_timestamp() AS expired INTO ses
    FROM core.checkout_session cs
   WHERE cs.id = p_session AND cs.user_id = actor AND cs.type = 'PRODUCT_PURCHASE'
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN PERFORM core.fail('NOT_FOUND', 'checkout session not found'); END IF;
  IF ses.state <> 'OPEN' THEN PERFORM core.fail('CONFLICT', 'checkout session is no longer open'); END IF;
  IF ses.expired THEN PERFORM core.fail('CHECKOUT_EXPIRED', 'checkout session has expired'); END IF;
  IF p_address IS NOT NULL THEN
    PERFORM 1 FROM private.address a
     WHERE a.id = p_address AND a.user_id = actor AND a.kind = 'REAL' FOR KEY SHARE;
    IF NOT FOUND THEN PERFORM core.fail('ADDRESS_NOT_FOUND', 'address not found'); END IF;
  END IF;
  INSERT INTO core.checkout_destination AS d (session_id, user_id, kind, address_id)
  VALUES (p_session, actor, CASE WHEN p_address IS NULL THEN 'FICTIONAL_SPOT' ELSE 'ADDRESS' END, p_address)
  ON CONFLICT (session_id) DO UPDATE
    SET kind = EXCLUDED.kind, address_id = EXCLUDED.address_id, updated_at = clock_timestamp();
  RETURN CASE WHEN p_address IS NULL
              THEN jsonb_build_object('sessionId', p_session, 'deliverTo', 'FICTIONAL_SPOT')
              ELSE jsonb_build_object('sessionId', p_session, 'deliverTo', 'ADDRESS', 'addressId', p_address) END;
END $$;

-- Inside the pay transaction, after every other lock (§4 #11): the order group's destination.
-- Refuses (ADDRESS_NOT_FOUND, which rolls the whole purchase back) when the chosen address is not
-- one of the actor's own any more.
CREATE FUNCTION core.purchase_record_delivery(actor uuid, p_session uuid, p_group uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  dest  record;
  q     jsonb;
  kind_ text := 'FICTIONAL_SPOT';
  aid   uuid;
  addr  record;
BEGIN
  SELECT d.kind, d.address_id INTO dest FROM core.checkout_destination d
   WHERE d.session_id = p_session AND d.user_id = actor;
  IF FOUND THEN
    kind_ := dest.kind;
    aid := dest.address_id;
  ELSE
    SELECT cs.quote INTO q FROM core.checkout_session cs WHERE cs.id = p_session AND cs.user_id = actor;
    IF jsonb_typeof(q -> 'addressId') = 'string' AND core.is_uuid(q ->> 'addressId') THEN
      kind_ := 'ADDRESS';
      aid := (q ->> 'addressId')::uuid;
    END IF;
  END IF;

  IF kind_ = 'ADDRESS' THEN
    SELECT a.id, a.label, a.payload_enc INTO addr FROM private.address a
     WHERE a.id = aid AND a.user_id = actor AND a.kind = 'REAL' FOR KEY SHARE;
    IF aid IS NULL OR NOT FOUND THEN
      PERFORM core.fail('ADDRESS_NOT_FOUND', 'the delivery address is no longer saved; choose another');
    END IF;
    INSERT INTO private.order_delivery (order_group_id, user_id, kind, address_id, label, payload_enc)
    VALUES (p_group, actor, 'ADDRESS', addr.id, addr.label, addr.payload_enc);
  ELSE
    INSERT INTO private.order_delivery (order_group_id, user_id, kind) VALUES (p_group, actor, 'FICTIONAL_SPOT');
  END IF;
  -- the shipments point at the address (or at none) exactly as the order does
  UPDATE core.shipment sh SET address_id = CASE WHEN kind_ = 'ADDRESS' THEN aid END
    FROM core.seller_order so
   WHERE so.id = sh.seller_order_id AND so.order_group_id = p_group
     AND sh.address_id IS DISTINCT FROM (CASE WHEN kind_ = 'ADDRESS' THEN aid END);
END $$;

-- ---------------------------------------------------------------- the buyer's order
CREATE FUNCTION core.my_order_delivery(p_group uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := core.actor_id();
  od    private.order_delivery;
BEGIN
  IF actor IS NULL OR NOT EXISTS (SELECT 1 FROM core.order_group g WHERE g.id = p_group AND g.buyer_user_id = actor) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO od FROM private.order_delivery d WHERE d.order_group_id = p_group AND d.user_id = actor;
  IF NOT FOUND OR od.kind = 'FICTIONAL_SPOT' THEN
    RETURN jsonb_build_object('kind', 'FICTIONAL_SPOT');   -- orders from before 0058 too
  END IF;
  IF od.payload_enc IS NULL THEN
    RETURN jsonb_build_object('kind', 'ADDRESS_REMOVED');
  END IF;
  RETURN jsonb_build_object('kind', 'ADDRESS', 'label', od.label, 'payloadEnc', encode(od.payload_enc, 'base64'));
END $$;

-- ---------------------------------------------------------------- the pay transaction
-- core.commit_purchase of 0032, unchanged except that the order group's destination is recorded
-- right after core.purchase_write, inside the same refusal block (§4 #11).
CREATE OR REPLACE FUNCTION core.commit_purchase(session_id uuid, attempt_id uuid, idempotency_key text, request_hash bytea,
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
    -- the destination (R5.2), after every lock of the canonical order (§4 #11)
    PERFORM core.purchase_record_delivery(actor, commit_purchase.session_id, (receipt ->> 'orderGroupId')::uuid);
    -- the bought products leave the buyer's cart in this same transaction (PRD R2.2); after
    -- every lock of the canonical order, on the buyer's own cart rows only
    DELETE FROM core.cart_line cl
     WHERE cl.user_id = actor
       AND cl.product_id IN (SELECT (l ->> 'productId')::uuid
                               FROM core.checkout_session cs, jsonb_array_elements(cs.quote -> 'lines') l
                              WHERE cs.id = commit_purchase.session_id AND cs.user_id = actor);
    -- US-04: the spending route reached (whether or not it is the route that unlocked)
    IF (receipt ->> 'balanceAfterPaise')::bigint < core.config_paise(
         (SELECT cs.config_version FROM core.checkout_session cs WHERE cs.id = commit_purchase.session_id),
         ARRAY['creator_threshold_paise'], 1000000000) THEN
      INSERT INTO core.creator_route_evidence (user_id, route, evidence_order_group_id)
      VALUES (actor, 'SPEND', (receipt ->> 'orderGroupId')::uuid) ON CONFLICT DO NOTHING;
      SET CONSTRAINTS ALL IMMEDIATE;
      SET CONSTRAINTS ALL DEFERRED;
    END IF;
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
REVOKE ALL ON FUNCTION core.guard_order_delivery(), core.erase_address_copies(), core.address_json(private.address),
  core.address_actor(), core.address_check_input(text, bytea, boolean), core.my_addresses(),
  core.address_create(text, bytea, boolean), core.address_update(uuid, text, bytea), core.address_delete(uuid),
  core.address_set_default(uuid), core.checkout_address_check(uuid), core.checkout_set_destination(uuid, uuid),
  core.purchase_record_delivery(uuid, uuid, uuid), core.my_order_delivery(uuid)
  FROM PUBLIC, app_web, app_pay, app_jobs, npc_worker, research_ro;
GRANT EXECUTE ON FUNCTION core.my_addresses(), core.address_create(text, bytea, boolean),
  core.address_update(uuid, text, bytea), core.address_delete(uuid), core.address_set_default(uuid),
  core.my_order_delivery(uuid) TO app_web;
GRANT EXECUTE ON FUNCTION core.checkout_address_check(uuid), core.checkout_set_destination(uuid, uuid) TO app_pay;
