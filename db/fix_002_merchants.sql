-- db/fix_002_merchants.sql
-- Wire mixed-merchant defaults into the merchant cache (LOCKED, so they stick + skip the LLM),
-- and apply the specific one-off categorizations identified during review.
-- Safe to run once; idempotent. Apply AFTER fix_001.
--   psql "$DATABASE_URL" -f db/fix_002_merchants.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- Helper approach: set the merchant's locked default, THEN re-point existing
-- transactions of that merchant to the new category (unless user_corrected).
-- We match merchants by display_name (set by the importer's fingerprint).
-- ---------------------------------------------------------------------------

-- 1. Mixed-merchant defaults (locked). Un-split transactions get these; split the exceptions
--    later in the dashboard. These are the bulk of the needs_review pile.
UPDATE merchants SET default_category='shopping',     locked=true, updated_at=now() WHERE display_name ILIKE 'Amazon%';
UPDATE merchants SET default_category='groceries',    locked=true, updated_at=now() WHERE display_name ILIKE 'Target%';
UPDATE merchants SET default_category='groceries',    locked=true, updated_at=now() WHERE display_name ILIKE 'Walmart%' OR display_name ILIKE 'Wm Supercenter%';
UPDATE merchants SET default_category='kid_expenses', locked=true, updated_at=now() WHERE display_name ILIKE 'Costco%';

-- 2. Specific one-off merchants identified during review (locked so they never re-clog the queue).
UPDATE merchants SET default_category='housing',            locked=true, updated_at=now() WHERE display_name ILIKE 'Holistic Tree%';
UPDATE merchants SET default_category='housing',            locked=true, updated_at=now() WHERE display_name ILIKE 'Neighborhoodn%';   -- HOA
UPDATE merchants SET default_category='eating_out',         locked=true, updated_at=now() WHERE display_name ILIKE 'Birdhouse%';
UPDATE merchants SET default_category='outings_activities', locked=true, updated_at=now() WHERE display_name ILIKE 'Journey Hollywood%';
UPDATE merchants SET default_category='fitness',            locked=true, updated_at=now() WHERE display_name ILIKE 'Box Basics%';
UPDATE merchants SET default_category='giving',             locked=true, updated_at=now() WHERE display_name ILIKE 'Lgc Doordash Giftcard%';
UPDATE merchants SET default_category='giving',             locked=true, updated_at=now() WHERE display_name ILIKE 'Flatirons Community%';
UPDATE merchants SET default_category='giving',             locked=true, updated_at=now() WHERE display_name ILIKE 'Stumo%';
UPDATE merchants SET default_category='home_entertainment', locked=true, updated_at=now() WHERE display_name ILIKE 'Angel%';
UPDATE merchants SET default_category='kid_expenses',       locked=true, updated_at=now() WHERE display_name ILIKE 'Huloosleep%';
UPDATE merchants SET default_category='insurance',         locked=true, updated_at=now() WHERE display_name ILIKE 'Google Google Store%';  -- Pixel device insurance

-- 3. Re-point existing transactions to their merchant's new locked default,
--    but never override a row a human has explicitly corrected.
UPDATE transactions t
SET category = m.default_category, confidence = 1.0
FROM merchants m
WHERE t.merchant_id = m.id
  AND m.locked = true
  AND m.default_category IS NOT NULL
  AND t.is_deleted = false
  AND t.user_corrected = false
  AND t.category IS DISTINCT FROM m.default_category;

-- 4. The checks you identified by number.
UPDATE transactions SET category='childcare', user_corrected=true WHERE merchant_raw ILIKE '%Check Paid #1162%' AND is_deleted=false;
-- (Check #1160 and #1161 remain needs_review — assign in the dashboard when you recall them.)

COMMIT;

-- Report the corrected top spending categories.
SELECT category, COUNT(*) AS n, ROUND(SUM(-amount),2) AS spend
FROM transactions
WHERE is_deleted = false AND is_spending = true
GROUP BY category ORDER BY spend DESC LIMIT 20;
