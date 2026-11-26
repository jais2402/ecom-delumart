-- The pay path of the new methods (PRD R4.2, R4.3, R7; US-35).
--
--  * core.purchase_write (0018, otherwise unchanged) accepts DELULUPAY_ID and NET_BANKING attempts (their
--    authentication is the challenge of 0101) and gates every method on its own kill switch; the
--    commit-time share lock on switches (LLD §4: shared, after the wallets are not needed) now names the
--    two further switches, in name order, as before.
--  * core.commit_purchase (0058, otherwise unchanged) runs core.payment_method_gate_for_pay before the
--    purchase is written: the method must be available (configuration, switch, maintenance window) and the
--    amount within its per-attempt and per-day limits, or the attempt FAILS with METHOD_UNAVAILABLE or
--    METHOD_LIMIT_EXCEEDED and nothing is debited. It takes the actor's advisory lock first (before any row
--    lock of the canonical order, LLD §4) so that two concurrent payments of one buyer count each other's
--    total toward the daily limit. A request that purchase_write would refuse anyway (closed or expired
--    session, an unauthenticated attempt) is not gated here, so its error is the one it always was.
--  * Nothing about pricing or the ledger changes: the amounts still come from the pricing function and
--    every journal still sums to zero.

CREATE FUNCTION core.payment_method_gate_for_pay(p_actor uuid, p_session uuid, p_attempt uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  a record;
BEGIN
  PERFORM core.lock_actor('core.payment_method_limits', p_actor);
  SELECT pa.method, cs.total_paise INTO a
    FROM core.payment_attempt pa JOIN core.checkout_session cs ON cs.id = pa.session_id
   WHERE pa.id = p_attempt AND pa.session_id = p_session AND pa.user_id = p_actor AND cs.user_id = p_actor
     AND pa.state = 'PENDING' AND pa.authenticated_at IS NOT NULL
     AND cs.state = 'OPEN' AND cs.expires_at > clock_timestamp();
  IF FOUND THEN
    PERFORM core.payment_method_gate(p_actor, a.method, a.total_paise);
  END IF;
END $$;
REVOKE ALL ON FUNCTION core.payment_method_gate_for_pay(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;

-- ---------------------------------------------------------------- the locked part of pay (0018)
CREATE OR REPLACE FUNCTION core.purchase_write(actor uuid, p_session_id uuid, p_attempt_id uuid, p_order jsonb) RETURNS jsonb
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
  line_limit  bigint;
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
  IF att.method <> ALL (core.payment_method_names()) THEN PERFORM core.fail('METHOD_UNAVAILABLE', 'method not offered'); END IF;
  IF core.payment_method_switch(att.method) IS NOT NULL AND NOT core.switch_on(core.payment_method_switch(att.method)) THEN
    PERFORM core.fail('METHOD_UNAVAILABLE', 'That payment method is switched off right now. No fictional money moved.');
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
  -- at most `purchase_lines_per_day` (100) completed purchase lines per actor per UTC day; checked
  -- here before any lock on another user's rows, and again under the buyer's wallet lock (#9)
  line_limit := core.config_int(core.current_config_id(), ARRAY['purchase_lines_per_day'], 100);
  IF core.purchase_lines_today(actor) + cardinality(ids) > line_limit THEN
    PERFORM core.fail('RATE_LIMITED', 'daily purchase limit reached; try again tomorrow (UTC)');
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

  -- the switches the commit-time check reads under lock (0016 R7), shared, now: after the wallets
  -- this purchase takes no lock it does not already hold, so nothing it might wait for can keep
  -- a seller's wallet locked (fourth security review)
  PERFORM 1 FROM core.system_switch sw
   WHERE sw.name IN ('payments_card', 'payments_delulupay_id', 'payments_netbanking', 'purchases') ORDER BY sw.name FOR SHARE;
  -- #9 wallets: buyer and every seller, ascending account id (ledger.sync_wallets waits at most
  -- 2 s). Taken last: a refused purchase never queues on (or holds) anyone's wallet, and no lock
  -- is taken after them.
  wallet_accts := ARRAY(SELECT DISTINCT x FROM unnest(
                    ARRAY[buyer_acct] || ARRAY(SELECT (owner_accts ->> (owners ->> (s ->> 'sellerId')))::uuid
                                                 FROM jsonb_array_elements(priced -> 'sellers') s
                                                WHERE s ->> 'sellerId' <> 'SEED')) x ORDER BY x);
  PERFORM ledger.sync_wallets(wallet_accts);
  SELECT w.available_paise INTO available FROM ledger.wallet w WHERE w.account_id = buyer_acct;
  -- the daily line limit again, under the buyer's wallet lock: the buyer's concurrent purchases
  -- serialise on it, so this count includes every purchase of theirs that committed before
  IF core.purchase_lines_today(actor) + cardinality(ids) > line_limit THEN
    PERFORM core.fail('RATE_LIMITED', 'daily purchase limit reached; try again tomorrow (UTC)');
  END IF;
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

-- ---------------------------------------------------------------- the pay transaction (0058)
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
    -- the method's availability and limits (PRD R4.2, R7, US-35), serialised per actor so that concurrent
    -- payments cannot all pass the same daily total; a refusal is recorded like any other (METHOD_UNAVAILABLE,
    -- METHOD_LIMIT_EXCEEDED: the attempt FAILED, no money moved)
    PERFORM core.payment_method_gate_for_pay(actor, commit_purchase.session_id, commit_purchase.attempt_id);
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
