-- Closes three ledger gaps.
--
-- A1. Journal types by role. No application role inserts journals directly any more: user
--     journals (STARTER_GRANT, PURCHASE) are written by the owner-run command functions of
--     0018 for the signed-in actor, which only app_pay may execute; COMPENSATION, REVERSAL and
--     ACCOUNT_RETIREMENT are admin actions that only the database owner may create (role check
--     in 0016) until the reversal feature brings them back behind approved pending actions. No
--     application role (app_web, app_pay, app_jobs) holds INSERT on ledger tables (0011).
--
--     COMPANY_REGISTRATION, WAREHOUSE_PURCHASE and MEMBERSHIP are NOT allowed yet: nothing
--     backs them (no company-registration, warehouse or membership purchase records and
--     checks exist). Add each type only together with the table, command function and
--     commit-time check that back it (0016 refuses them for app_pay and app_web as well).

-- A2. A posting is never committed without the wallet reflecting it: at commit,
--     every USER account that received a posting in the transaction must have a
--     wallet row equal to the sum of its postings. (0003 checks wallets that were
--     written; this checks accounts that were posted to, so a missing wallet update
--     is caught too.) Checked once per inserted posting, deferred to commit.
CREATE FUNCTION ledger.assert_posted_wallet_synced() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  acct_type text;
  balance   bigint;
  posted    bigint;
BEGIN
  PERFORM ledger.require_read_committed();
  SELECT type INTO acct_type FROM ledger.ledger_account WHERE id = NEW.account_id;
  IF acct_type IS DISTINCT FROM 'USER' THEN
    RETURN NULL;   -- MINT and SINK have no cached balance
  END IF;
  SELECT available_paise INTO balance FROM ledger.wallet WHERE account_id = NEW.account_id;
  SELECT COALESCE(SUM(amount), 0) INTO posted FROM ledger.posting WHERE account_id = NEW.account_id;
  IF balance IS NULL OR balance <> posted THEN
    RAISE EXCEPTION 'account % received postings but its wallet (%) does not equal the sum of its postings (%)',
      NEW.account_id, COALESCE(balance::text, 'missing'), posted USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER posting_wallet_synced AFTER INSERT ON ledger.posting
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.assert_posted_wallet_synced();

-- A3. MINT in PURCHASE journals. A PURCHASE may debit MINT only to fund a platform
--     coupon discount (LLD §5.1). Platform coupons are not built yet, so this hook
--     forbids any MINT posting in a PURCHASE journal. When platform coupons arrive,
--     replace this function (new migration) to allow a MINT debit equal to the
--     platform discount only when a PLATFORM coupon_redemption for the journal's
--     order_group_id exists in the same transaction.
CREATE FUNCTION ledger.assert_purchase_mint() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.event_type = 'PURCHASE' AND EXISTS (
       SELECT 1 FROM ledger.posting p JOIN ledger.ledger_account a ON a.id = p.account_id
        WHERE p.journal_id = NEW.id AND a.type = 'MINT') THEN
    RAISE EXCEPTION 'PURCHASE journal % may not post to MINT (no platform coupon redemption backs it)', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_purchase_mint AFTER INSERT ON ledger.journal
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.assert_purchase_mint();

REVOKE ALL ON FUNCTION ledger.assert_posted_wallet_synced(), ledger.assert_purchase_mint() FROM PUBLIC;
