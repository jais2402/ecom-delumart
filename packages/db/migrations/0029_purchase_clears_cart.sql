-- A successful purchase removes the bought products from the buyer's cart (PRD R2.2), inside
-- the pay transaction: core.commit_purchase of 0018, unchanged except for the DELETE after
-- core.purchase_write succeeds. A refused purchase (DM001) rolls the DELETE back with everything
-- else, so the cart is left as it was and shows the line issues. Same owner, signature, settings
-- and grants (CREATE OR REPLACE keeps the EXECUTE grant to app_pay).

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
    -- the bought products leave the buyer's cart in this same transaction (PRD R2.2); after
    -- every lock of the canonical order, on the buyer's own cart rows only
    DELETE FROM core.cart_line cl
     WHERE cl.user_id = actor
       AND cl.product_id IN (SELECT (l ->> 'productId')::uuid
                               FROM core.checkout_session cs, jsonb_array_elements(cs.quote -> 'lines') l
                              WHERE cs.id = commit_purchase.session_id AND cs.user_id = actor);
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
