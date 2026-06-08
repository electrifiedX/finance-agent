-- db/queries.sql — reference queries for the dashboard. These are the aggregations that
-- MUST be right (especially splits-aware totals). The Next.js API routes should use these
-- shapes. Each is parameterized by a date range :start / :end (inclusive).

-- ===========================================================================
-- splitsaware_line: ONE row per category-contribution per transaction.
-- A transaction with NO splits contributes its full amount under its own category.
-- A transaction WITH splits contributes amount*percent/100 under each split category,
-- and does NOT contribute under its own category (never double-count).
-- Excludes soft-deleted and non-spending rows where appropriate at the call site.
-- ===========================================================================
-- Reusable CTE pattern — paste into the queries below.
--   WITH lines AS (
--     -- unsplit transactions
--     SELECT t.id, t.occurred_at, t.account_id, t.amount, t.category, t.is_spending
--     FROM transactions t
--     WHERE t.is_deleted = false
--       AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id)
--     UNION ALL
--     -- split transactions: one line per split
--     SELECT t.id, t.occurred_at, t.account_id,
--            ROUND(t.amount * s.percent / 100.0, 2) AS amount,
--            s.category, t.is_spending
--     FROM transactions t
--     JOIN transaction_splits s ON s.transaction_id = t.id
--     WHERE t.is_deleted = false
--   )

-- ---------------------------------------------------------------------------
-- 1. Spending by category for a period (splits-aware), highest -> lowest.
-- ---------------------------------------------------------------------------
WITH lines AS (
  SELECT t.id, t.occurred_at, t.amount, t.category, t.is_spending
  FROM transactions t
  WHERE t.is_deleted = false
    AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id)
  UNION ALL
  SELECT t.id, t.occurred_at, ROUND(t.amount * s.percent / 100.0, 2), s.category, t.is_spending
  FROM transactions t
  JOIN transaction_splits s ON s.transaction_id = t.id
  WHERE t.is_deleted = false
)
SELECT category, SUM(-amount) AS spend
FROM lines
WHERE is_spending = true
  AND occurred_at BETWEEN :start AND :end
GROUP BY category
ORDER BY spend DESC;

-- ---------------------------------------------------------------------------
-- 2. Top vendors for a period (by spend), highest -> lowest, with count.
--    Vendors use the merchant display name; splits don't change the vendor.
-- ---------------------------------------------------------------------------
SELECT m.display_name AS vendor, SUM(-t.amount) AS spend, COUNT(*) AS txns
FROM transactions t
JOIN merchants m ON m.id = t.merchant_id
WHERE t.is_deleted = false
  AND t.is_spending = true
  AND t.occurred_at BETWEEN :start AND :end
GROUP BY m.display_name
ORDER BY spend DESC
LIMIT 25;

-- ---------------------------------------------------------------------------
-- 3. Period summary: income, expenses, net. Net > 0 = "saved", net < 0 = "overspent".
--    Income/non-spending excluded from expenses; income summed from is_spending=false
--    inflow categories (income, misc_income).
-- ---------------------------------------------------------------------------
SELECT
  COALESCE(SUM(amount) FILTER (WHERE category IN ('income','misc_income')), 0) AS income,
  COALESCE(SUM(-amount) FILTER (WHERE is_spending = true), 0)                 AS expenses,
  COALESCE(SUM(amount) FILTER (WHERE category IN ('income','misc_income')), 0)
    - COALESCE(SUM(-amount) FILTER (WHERE is_spending = true), 0)             AS net
FROM transactions
WHERE is_deleted = false
  AND occurred_at BETWEEN :start AND :end;

-- ---------------------------------------------------------------------------
-- 4. Monthly series for the Overview bar chart (per month: income, expenses, net).
--    Drives the bars + the color-coded net + the average-month line.
-- ---------------------------------------------------------------------------
SELECT
  date_trunc('month', occurred_at)::date AS month,
  COALESCE(SUM(amount) FILTER (WHERE category IN ('income','misc_income')), 0) AS income,
  COALESCE(SUM(-amount) FILTER (WHERE is_spending = true), 0)                 AS expenses,
  COALESCE(SUM(amount) FILTER (WHERE category IN ('income','misc_income')), 0)
    - COALESCE(SUM(-amount) FILTER (WHERE is_spending = true), 0)             AS net
FROM transactions
WHERE is_deleted = false
  AND occurred_at BETWEEN :start AND :end
GROUP BY 1
ORDER BY 1;

-- ---------------------------------------------------------------------------
-- 5. Single-category monthly series (Overview category dropdown), splits-aware.
--    :category is the selected category; gives one bar per month for just that category.
-- ---------------------------------------------------------------------------
WITH lines AS (
  SELECT t.id, t.occurred_at, t.amount, t.category, t.is_spending
  FROM transactions t
  WHERE t.is_deleted = false
    AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id)
  UNION ALL
  SELECT t.id, t.occurred_at, ROUND(t.amount * s.percent / 100.0, 2), s.category, t.is_spending
  FROM transactions t
  JOIN transaction_splits s ON s.transaction_id = t.id
  WHERE t.is_deleted = false
)
SELECT date_trunc('month', occurred_at)::date AS month, SUM(-amount) AS spend
FROM lines
WHERE is_spending = true
  AND category = :category
  AND occurred_at BETWEEN :start AND :end
GROUP BY 1
ORDER BY 1;

-- ---------------------------------------------------------------------------
-- 6. "To review" backlog (ALWAYS all-time, ignores the date filter).
-- ---------------------------------------------------------------------------
SELECT t.id, t.occurred_at, m.display_name, t.merchant_raw, t.amount, t.category, t.confidence
FROM transactions t
JOIN merchants m ON m.id = t.merchant_id
WHERE t.is_deleted = false
  AND t.user_corrected = false
  AND (t.category = 'uncategorized' OR t.category = 'needs_review' OR t.confidence < 0.7)
ORDER BY t.occurred_at DESC;

-- ---------------------------------------------------------------------------
-- 7. Recurring/subscription detection (Subscriptions page).
--    Merchants charged in >= 3 distinct months with a stable-ish amount.
-- ---------------------------------------------------------------------------
SELECT m.display_name AS vendor,
       ROUND(AVG(-t.amount), 2)                       AS avg_monthly,
       ROUND(AVG(-t.amount) * 12, 2)                  AS annualized,
       COUNT(DISTINCT date_trunc('month', t.occurred_at)) AS months_seen
FROM transactions t
JOIN merchants m ON m.id = t.merchant_id
WHERE t.is_deleted = false
  AND t.is_spending = true
GROUP BY m.display_name
HAVING COUNT(DISTINCT date_trunc('month', t.occurred_at)) >= 3
   AND stddev_pop(-t.amount) < (AVG(-t.amount) * 0.25)   -- amount roughly stable
ORDER BY annualized DESC;
