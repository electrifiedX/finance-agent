# Setup & Cursor Composer Instructions

This kit gives you a working backend foundation (database schema, seven CSV importers,
categorization, and the dashboard's core queries). The importers are tested against your real
exports. Cursor's job is to wire up the environment and build the Next.js dashboard on top.

Read `docs/BRIEF.md` first — it's the full spec. This file is the runbook.

---

## Part A — One-time local setup (do this yourself first, ~20 min)

You're on the Mac Mini M4. Do this in Terminal before opening Cursor, so the foundation is real.

### 1. Get this code into your repo
You said the `finance-agent` GitHub repo is empty. Put these files in it:
```bash
cd ~/path/to/finance-agent          # your local clone
# copy the contents of this kit into the repo root, then:
git add .
git commit -m "Foundation: schema, importers, categorization, queries"
git push
```

### 2. Install Postgres + Python deps
```bash
# Postgres (Homebrew):
brew install postgresql@16
brew services start postgresql@16

# Create the database and a role:
createuser finance 2>/dev/null; createdb -O finance finance

# Python deps (use a venv):
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 3. Configure env
```bash
cp .env.example .env
# Edit .env:
#   DATABASE_URL=postgresql://finance@localhost:5432/finance
#   ANTHROPIC_API_KEY=sk-ant-...   (from console.anthropic.com)
```

### 4. Create the schema and seed accounts
```bash
export $(grep -v '^#' .env | xargs)        # load .env into the shell
psql "$DATABASE_URL" -f db/schema.sql
psql "$DATABASE_URL" -f db/seed_accounts.sql
```

### 5. Import your real CSVs
```bash
cp /path/to/your/*.csv ./drop/           # all your bank exports
cp /path/to/your/*.CSV ./drop/
python -m importers.run ./drop
```
Expected output: one line per file, e.g. `OK  Chase_Prime_...CSV: chase -> Chase Prime | +438 new, 3 dup`.
Re-run it — the second run should show `+0 new` for every file (idempotent).

### 6. Categorize
```bash
python -m llm.categorize
```
This labels every transaction. New merchants get an LLM guess; you'll refine them in the app's
review queue later. Cheap (well under $1 for a full year on Claude Haiku).

### 7. Sanity-check the data
```bash
psql "$DATABASE_URL" -c "
  SELECT category, ROUND(SUM(-amount),2) AS spend
  FROM transactions WHERE is_spending AND NOT is_deleted
  GROUP BY category ORDER BY spend DESC LIMIT 15;"
```
Eyeball it: does total spend feel right? Are transfers absent from spending? If a category looks
way off, that's a merchant-cache fix you'll make in the app, not a code change.

**At this point your data layer is live and correct. Everything below is the dashboard.**

---

## Part B — Building the dashboard with Cursor Composer 2

Open the repo in Cursor. Composer 2 works best with one clear, scoped instruction at a time
rather than "build the whole app." Below are the prompts to give it, in order. Paste them one at
a time; let each finish and verify before the next.

### Prompt 1 — scaffold the Next.js app
```
Read docs/BRIEF.md sections 1, 3, and 11 for context.

Create a Next.js app (use the LATEST stable version — Next.js 16, App Router, TypeScript) in a
/web directory at the repo root. Note Next.js 15+ uses ASYNC Request APIs (cookies, headers,
params, searchParams must be awaited) and updated caching defaults — write code accordingly.
Use Tailwind. Add a Postgres client (the `pg` package) that reads DATABASE_URL from the
environment. Create a db helper at web/lib/db.ts that exports a query function using a
connection pool. Do not build any pages yet beyond a placeholder home page that confirms it
can connect to Postgres and count rows in the transactions table.
```
Verify: `cd web && npm run dev`, load localhost:3000, confirm it shows a transaction count.

### Prompt 2 — the API routes (use db/queries.sql as the source of truth)
```
Read db/queries.sql — these are the exact aggregations the dashboard needs, and the
splits-aware logic in queries 1 and 5 MUST be implemented exactly as written (a transaction
with splits is counted by its splits, never also by its own category).

Create Next.js API routes under web/app/api/ for:
- /api/summary?start=&end=   -> query 3 (income, expenses, net)
- /api/monthly?start=&end=   -> query 4 (per-month income/expenses/net)
- /api/category-series?category=&start=&end= -> query 5
- /api/categories?start=&end= -> query 1 (spend by category)
- /api/vendors?start=&end=    -> query 2 (top vendors)
- /api/review                 -> query 6 (all-time backlog, ignores dates)
- /api/subscriptions          -> query 7
- /api/transactions?start=&end=&category=&account= -> the period transaction list
Each route uses web/lib/db.ts. Return JSON. Keep the SQL faithful to db/queries.sql.

IMPORTANT — single-app architecture (prevents the remote-access bug):
- The frontend MUST call API routes with RELATIVE paths only: fetch('/api/summary'), NEVER
  fetch('http://localhost:3000/api/summary') and never any hardcoded host or port. Relative paths
  resolve to whatever domain served the page, so the app works identically on localhost AND through
  the Cloudflare tunnel from a phone. A hardcoded "localhost" in any frontend fetch is THE bug that
  breaks remote access (the browser's "localhost" is the phone, not the Mac Mini).
- Postgres is only ever accessed server-side via web/lib/db.ts (same machine). The browser never
  talks to the database directly. So DATABASE_URL using localhost is correct and never leaves the Mini.
- This is ONE Next.js app (pages + API routes together), not a separate frontend and backend. That's
  deliberate: only one service to expose, no cross-service routing.
```
Verify: hit each route in the browser, confirm JSON comes back.

### Prompt 3 — the Overview page
```
Read docs/BRIEF.md section 11, "Page 1 — Overview", and the "Design direction" subsection.
Build the Overview page (web/app/page.tsx) as the landing page. DARK theme.

Requirements:
- Top "yearly health strip": Yearly Income, Yearly Expenses, Net. Net is green if positive
  ("Saved $X") and red if negative ("Overspent $X"). Use tabular numerals, right-aligned money.
- A monthly bar chart (Recharts) from /api/monthly: one bar per month. Under/within each month
  show net color-coded green/red. Add a faint horizontal line at the average monthly spend.
- Clicking a bar navigates to /transactions?start=&end= for that month.
- A category dropdown above the chart: default "All expenses"; when a category is picked, the
  bars switch to that single category per month (call /api/category-series).
- A short trend indicator sentence (e.g. "Net improving 3 months running").

Design: keep it calm and high-contrast (NOT heavy glassmorphism). Reserve green/red for money
direction only. Use a distinctive readable font pairing, not Inter/Roboto/Arial. Card-based
layout with generous spacing — inspired by a polished dark dashboard but optimized for reading
money clearly.
```
Verify: Overview loads with your real numbers and the chart renders.

### Prompt 4 — the Transactions page
```
Read docs/BRIEF.md section 11, "Page 2 — Transactions". Build web/app/transactions/page.tsx.

Top to bottom:
1. "To review" section at the very top, fed by /api/review (ALL-TIME, ignores the date filter).
   Each row resolvable inline. When the backlog is empty, show a friendly "All caught up" state.
2. A date range selector (month buttons, full-year "2026", custom range) + category and account
   filters. These control sections 3-5 only, NOT the review section. Read start/end from the URL
   query so links from Overview work.
3. Period summary (/api/summary): income, expenses, net ("Saved/Overspent $X"), with a Recharts
   pie of spending by category to the right — show top 6-8 categories + an "Other" slice.
4. Top categories (/api/categories) and top vendors (/api/vendors), highest to lowest.
5. The transaction list (/api/transactions): date, merchant, amount, account, category, type.
   Clicking a row opens an edit/split modal (build the modal next).

Same dark, high-contrast design as Overview.
```

### Prompt 5 — the edit / split modal + the learning action
```
Read docs/BRIEF.md section 10 (categorization + splits + learning rule) and section 11
"Shared interactions". Build a modal used for both manual-add and editing an existing transaction.

- Edit any field: date, amount, merchant display name, category (dropdown of the taxonomy in
  llm/categorize.py), account, notes. Saving sets user_corrected=true.
- Soft delete (set is_deleted=true), never hard delete.
- "Apply to this merchant going forward" checkbox: when checked on a category change, update the
  merchant's default_category and set locked=true, and log to category_corrections.
- Split: add category lines as PERCENTAGES that must sum to exactly 100 (block save otherwise).
  Show the derived dollar amount next to each line live. Offer a saved per-merchant split
  template if one exists (split_templates), and offer to save the current split as the template.
- A persistent "+ Add expense" button in the top nav opens this same modal in add mode
  (source='manual').
Create the matching API routes (PATCH/POST) under web/app/api/transactions/.
```

### Prompt 6 — Subscriptions page + nav
```
Build web/app/subscriptions/page.tsx from /api/subscriptions (query 7): list recurring
merchants with monthly amount and annualized cost ("$14.99/mo = $180/yr"). Add a top nav across
all pages: Overview · Transactions · Subscriptions, plus the persistent "+ Add expense" button.
```

### After the dashboard works
- Phase 4: Lowe's PDF seed — see BRIEF.md §5g. Ask Composer to build importers/lowes_pdf.py
  using pdfplumber against your lowescard.pdf, mapping to the same NormalizedTxn shape.
- Phase 5: Gmail ingestion — see BRIEF.md §11b. Build jobs/gmail_ingest.py. The CRITICAL rules:
  track processed messages in the processed_emails table (NOT Gmail read/unread), write into
  Postgres via importers/common.py, and categorize through llm/categorize.py — do NOT
  re-implement categorization in the email script.

### Remote access (Cloudflare tunnel) — keep it to ONE service
When you want to reach the dashboard from your phone:
- Run the Next.js app in production mode on the Mini: `cd web && npm run build && npm start`
  (serves on port 3000). For always-on, wrap this in a launchd service like Postgres.
- Point the Cloudflare tunnel at `http://localhost:3000` ONLY. One service, one hostname
  (e.g. finance.yourdomain.com). Because the frontend uses relative API paths, everything —
  pages and /api routes — flows through that single tunnel with no extra routing.
- Do NOT tunnel Postgres (5432). The database stays private on the Mini; only the Next.js
  server touches it. This is the whole reason the single-app design avoids the multi-service
  tunnel headaches from before.

### ROADMAP: Loan tracking module (next-up feature)
Treat loans as first-class entities, not just categories — so the principal/interest split is
computed automatically instead of approximating each payment as all-transfer or all-expense.
Currently (stopgap) car-loan payments are categorized as `automotive` and mortgage/HELOC/HVAC as
`housing` — full payment counted as spending, principal included. That's a cash-flow view; this
module replaces it with accurate accounting.

Design sketch:
- New `loans` table: id, name, linked_merchant_id (or match rule), original_principal,
  current_balance, interest_rate (APR), term_months, start_date, monthly_payment, payment_category
  (automotive/housing/etc. for the interest portion).
- A "Loans" tab/page to enter and edit each loan's terms (Cybertruck, Model Y, mortgage, HELOC,
  HVAC/GreenSky). Terms entry is manual, one-time per loan.
- When a payment for a linked loan is recorded, the app uses amortization math (balance × monthly
  rate = interest; remainder = principal) to split it: interest portion -> a spending category
  (the loan's payment_category or a dedicated `interest`), principal portion -> reduces
  current_balance and is NOT counted as consumption spending.
- Payoff insight: with rate + balance + payment, show projected payoff date and interest-saved
  for extra payments. This is the wealth-building lens (watching liabilities fall), which matters
  more than spend-tracking for the multi-millionaire goal.
- Generalizes to all 5 loans. Net-worth view (assets - loan balances) becomes possible later.
Build this AFTER the app is in daily use (review queue cleared, subscriptions live, ingestion
working) — it's a real module (table + terms UI + amortization + wiring into category/spend views),
comparable in scope to one dashboard prompt. Don't let it jump the line ahead of using the app.

---

## How the pieces fit (so you can direct Composer confidently)

```
CSV files ─> importers/run.py ─> per-bank parser ─> importers/common.py ─┐
                                                                          ├─> Postgres
llm/categorize.py (merchant cache + few-shot LLM) ───────────────────────┘     │
                                                                                │
web/ (Next.js) ── API routes (db/queries.sql shapes) ── Overview/Transactions/Subscriptions
```

- **importers/common.py** is the heart: fingerprinting, dedupe keys, the upsert. Every ingestion
  path (CSV now, Gmail later) goes through it, so dedupe and the merchant cache always apply.
- **db/queries.sql** is the contract for the dashboard. If a number looks wrong in the UI, check
  it against the query here first.
- **The merchant cache learns**: locking a merchant's category in the app makes it permanent and
  free; the LLM only ever guesses genuinely new merchants, few-shot from your locked decisions.

## Tested and verified
All six CSV importers were run against your real exports before delivery:
Chase 441 txns, BofA 156, Citi, Target 42, Wells Fargo 176, Ally 197 — transfers correctly
excluded from spending, mortgage→housing, income→income, no dedupe collisions (the Target Ref#
reuse bug was found and fixed). Lowe's (PDF) is phase 4.
