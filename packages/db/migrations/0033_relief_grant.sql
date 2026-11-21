-- The relief grant (C): a person whose balance is below ₹10 lakh may claim ₹10 lakh once per UTC
-- day, at most seven times in the account's life, by completing one free action: saving a
-- PUBLISHED product they have never saved before. No purchase or sharing is needed.
--
-- The structural rules for RELIEF_GRANT journals already hold for every writer (0016 R1): exactly
-- ledger.relief_grant_paise() (₹10 lakh) MINT -> the acting user, backed by one RELIEF
-- grant_record dated today (UTC), at most one per UTC day (unique index, 0003), at most
-- ledger.relief_lifetime_max() (7) per user, and only while the balance before the grant was below
-- ledger.relief_wallet_ceiling_paise() (₹10 lakh). core.claim_relief is the command that writes
-- such a journal; it checks the same rules first so that a refusal has a stable code.
--
-- Locks: the actor's progression lock (0032) first, so one person's claims run one at a time,
-- then the wallet (LLD §4 #9), then the passport row and entitlement (#10; the save may complete
-- the passport's saves step).

-- Why the actor may not claim now, as a stable reason (NULL: eligible). Read under the wallet
-- lock by core.claim_relief; without it by core.relief_status.
CREATE FUNCTION core.relief_problem(actor uuid, balance bigint) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN (SELECT count(*) FROM ledger.grant_record g WHERE g.user_id = actor AND g.type = 'RELIEF')
         >= ledger.relief_lifetime_max() THEN 'LIFETIME_LIMIT'
    WHEN EXISTS (SELECT 1 FROM ledger.grant_record g
                  WHERE g.user_id = actor AND g.type = 'RELIEF'
                    AND g.utc_day = (clock_timestamp() AT TIME ZONE 'UTC')::date) THEN 'CLAIMED_TODAY'
    WHEN balance IS NULL OR balance >= ledger.relief_wallet_ceiling_paise() THEN 'BALANCE_TOO_HIGH'
  END
$$;

CREATE FUNCTION core.relief_json(actor uuid, balance bigint) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object(
    'eligible', core.relief_problem(actor, balance) IS NULL,
    'reason', core.relief_problem(actor, balance),
    'claimsUsed', used,
    'claimsMax', ledger.relief_lifetime_max(),
    'claimsRemaining', greatest(ledger.relief_lifetime_max() - used, 0),
    'balancePaise', balance::text,
    'ceilingPaise', ledger.relief_wallet_ceiling_paise()::text,
    'grantPaise', ledger.relief_grant_paise()::text,
    'nextResetAt', ((clock_timestamp() AT TIME ZONE 'UTC')::date + 1)::timestamp AT TIME ZONE 'UTC')
    FROM (SELECT count(*)::int AS used FROM ledger.grant_record g WHERE g.user_id = actor AND g.type = 'RELIEF') x
$$;

-- {eligible, reason (LIFETIME_LIMIT | CLAIMED_TODAY | BALANCE_TOO_HIGH | null), claimsUsed,
--  claimsMax, claimsRemaining, balancePaise, ceilingPaise, grantPaise, nextResetAt (next UTC midnight)}
CREATE FUNCTION core.relief_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor   uuid := core.require_actor();
  balance bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.user_profile up WHERE up.id = actor AND up.provisioned_at IS NOT NULL) THEN
    PERFORM core.fail('ONBOARDING_REQUIRED', 'finish onboarding first');
  END IF;
  SELECT w.available_paise INTO balance FROM ledger.ledger_account la JOIN ledger.wallet w ON w.account_id = la.id
   WHERE la.user_id = actor AND la.type = 'USER';
  RETURN core.relief_json(actor, balance);
END $$;

-- Saves the product (which must be PUBLISHED and never saved by the actor before), posts the
-- RELIEF_GRANT journal MINT -> actor with its grant record, syncs the wallet and returns
-- {productId, grantedPaise, ...relief_json} with the new balance. Refusals: PRODUCT_UNAVAILABLE,
-- CONFLICT (the product was saved before), RELIEF_NOT_ELIGIBLE (balance, already claimed today),
-- RELIEF_LIMIT (seven claims used). Duplicate and concurrent claims serialise on the actor's
-- progression lock: one grant per UTC day.
CREATE FUNCTION core.claim_relief(product_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor   uuid := core.progression_actor();
  acct    uuid;
  balance bigint;
  problem text;
  amount  bigint := ledger.relief_grant_paise();
  jid     uuid := core.uuid_v7();
  gid     uuid := core.uuid_v7();
BEGIN
  IF claim_relief.product_id IS NULL THEN
    PERFORM core.fail('VALIDATION_FAILED', 'productId is required');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.product p JOIN core.product_version v ON v.id = p.current_version_id
                  WHERE p.id = claim_relief.product_id AND v.product_id = p.id AND p.status = 'PUBLISHED') THEN
    PERFORM core.fail('PRODUCT_UNAVAILABLE', 'that product is not available');
  END IF;
  SELECT la.id INTO acct FROM ledger.ledger_account la WHERE la.user_id = actor AND la.type = 'USER';
  IF acct IS NULL THEN
    PERFORM core.fail('ONBOARDING_REQUIRED', 'finish onboarding first');
  END IF;
  -- #9 the wallet (ledger.sync_wallets locks it, waiting at most 2 s)
  PERFORM ledger.sync_wallets(ARRAY[acct]);
  SELECT w.available_paise INTO balance FROM ledger.wallet w WHERE w.account_id = acct;
  problem := core.relief_problem(actor, balance);
  IF problem = 'LIFETIME_LIMIT' THEN
    PERFORM core.fail('RELIEF_LIMIT', 'all relief grants of this account are used');
  ELSIF problem = 'CLAIMED_TODAY' THEN
    PERFORM core.fail('RELIEF_NOT_ELIGIBLE', 'relief was already claimed today (UTC)');
  ELSIF problem IS NOT NULL THEN
    PERFORM core.fail('RELIEF_NOT_ELIGIBLE', 'relief is for a balance below ₹10 lakh');
  END IF;
  IF EXISTS (SELECT 1 FROM core.product_save s WHERE s.user_id = actor AND s.product_id = claim_relief.product_id) THEN
    PERFORM core.fail('CONFLICT', 'save a product you have not saved before');
  END IF;

  -- ------------------------------------------------ writes
  SET CONSTRAINTS ALL DEFERRED;
  INSERT INTO core.product_save (id, user_id, product_id, first_saved_at, saved_at)
  VALUES (core.uuid_v7(), actor, claim_relief.product_id, clock_timestamp(), clock_timestamp());
  INSERT INTO ledger.journal (id, event_type, config_version, idempotency_ref)
  VALUES (jid, 'RELIEF_GRANT', core.current_config_id(), gid);
  INSERT INTO ledger.posting (journal_id, account_id, amount, memo) VALUES
    (jid, '00000000-0000-7000-8000-000000000001'::uuid, -amount, 'Relief grant'),
    (jid, acct, amount, 'Relief grant');
  INSERT INTO ledger.grant_record (id, user_id, journal_id, type, amount, utc_day)
  VALUES (gid, actor, jid, 'RELIEF', amount, (clock_timestamp() AT TIME ZONE 'UTC')::date);
  PERFORM ledger.sync_wallets(ARRAY[acct]);
  -- ids and amounts only (invariant 8)
  INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
  VALUES (core.uuid_v7(), 'relief_granted', jid, jsonb_build_object(
    'journalId', jid, 'grantRecordId', gid, 'userId', actor, 'amountPaise', amount::text), 1);
  -- #10 the save may complete the passport's saves step
  PERFORM core.passport_evaluate(actor);
  -- every structural check of 0003/0014/0016 now; this seals the journal (R9)
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;

  SELECT w.available_paise INTO balance FROM ledger.wallet w WHERE w.account_id = acct;
  RETURN jsonb_build_object('productId', claim_relief.product_id, 'grantedPaise', amount::text)
         || core.relief_json(actor, balance);
END $$;

REVOKE ALL ON FUNCTION core.relief_problem(uuid, bigint), core.relief_json(uuid, bigint), core.relief_status(),
  core.claim_relief(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.relief_status() TO app_web;
-- a money command: the checkout role only
GRANT EXECUTE ON FUNCTION core.claim_relief(uuid) TO app_pay;
