-- db/fix_001_debt_and_cash.sql
-- One-time correction for rows already loaded before the Ally importer rules were updated.
-- Safe to run once. Re-running is harmless (idempotent UPDATEs).
-- Apply with: psql "$DATABASE_URL" -f db/fix_001_debt_and_cash.sql

BEGIN;

-- 1. Home-secured debt -> housing (mortgage new servicer, HELOC, HVAC loan).
UPDATE transactions SET category = 'housing', is_spending = true, user_corrected = true
WHERE (merchant_raw ILIKE '%NSM DBAMR.COOPER%'
    OR merchant_raw ILIKE '%MR COOPER%'
    OR merchant_raw ILIKE '%FIGURE LENDING%'
    OR merchant_raw ILIKE '%AVEN%'
    OR merchant_raw ILIKE '%GREENSKY%')
  AND is_deleted = false;

-- 2. ATM withdrawals -> cash_withdrawal, NOT spending (real cash spend is logged manually).
UPDATE transactions SET category = 'cash_withdrawal', txn_type = 'transfer', is_spending = false, user_corrected = true
WHERE (merchant_raw ILIKE '%U.S. BANK TM%'
    OR merchant_raw ILIKE '%US BANK ERIE%'
    OR merchant_raw ILIKE '%BANK OF AMERICA *BRAZOS%')
  AND is_deleted = false;

-- 3. Vehicle registration -> automotive.
UPDATE transactions SET category = 'automotive', is_spending = true, user_corrected = true
WHERE merchant_raw ILIKE '%COGOV COMOTORVEH%'
  AND is_deleted = false;

-- 3b. United Power electric co-op -> utilities.
UPDATE transactions SET category = 'utilities', is_spending = true, user_corrected = true
WHERE merchant_raw ILIKE '%UNITED POWER%'
  AND is_deleted = false;

-- 4. THE BUG: any row categorized 'transfer' must NOT be spending. Force consistency.
UPDATE transactions SET is_spending = false
WHERE category = 'transfer' AND is_spending = true;

-- 5. Same hardening for the other non-spending categories, in case any leaked.
UPDATE transactions SET is_spending = false
WHERE category IN ('income', 'misc_income', 'refund', 'business_expense', 'cash_withdrawal')
  AND is_spending = true;

COMMIT;

-- Report the new top categories so you can eyeball the result immediately.
SELECT category, is_spending, COUNT(*) AS n, ROUND(SUM(-amount), 2) AS spend
FROM transactions
WHERE is_deleted = false AND is_spending = true
GROUP BY category, is_spending
ORDER BY spend DESC
LIMIT 20;
