# Family Finance Tracker — Project Kickoff Brief

> Drop this into Cursor as the root project brief (`README.md` or `/docs/BRIEF.md`).
> It defines the goal, the phased build order, the data model, the category taxonomy,
> and the exact shape of every real CSV/format we're starting with.

---

## 1. What we're building

A self-hosted personal finance tool for a two-person household (shared single login — no
per-user views needed). Goal of **v1 is awareness**: see clearly where the money goes each
month, by category, by vendor, by account. Budgeting and targets come later (phase 2) — do
not build them now, but don't make schema choices that block them.

**Host:** Mac Mini M4 in the basement, always on. Postgres + backend + frontend all run
locally. Public access via existing Cloudflare Tunnel (`finance.<ourdomain>`). No cloud
hosting bill.

**Hard rule for v1:** boring and reliable beats clever. The version that gets used is the
one that just works for six months.

### What the LLM does (and doesn't)

- **Code parses CSVs.** Every format here has fixed columns. Parsing is deterministic Python.
  The LLM is NEVER fed raw CSV text and never "reads" a file — that would add cost, latency,
  and hallucination risk for zero benefit.
- **The LLM does two fuzzy jobs only:** (1) merchant normalization (`TST*BIRDHOUSE 720-539-9099 CO`
  → "Birdhouse") and (2) category assignment. Both are post-parse, on already-structured data.
- Wrap all LLM calls behind a single `llm/` module with a stable signature so the provider
  (Anthropic API now → local Ollama later) can be swapped without touching callers.

### Three ingestion paths (only two live in the app)

| Path | Where | When | In the app UI? |
|------|-------|------|----------------|
| **Bulk historical (CSV/PDF)** | CLI scripts on the Mini | One-time + occasional | **No** — operational scripts only |
| **Automated (email)** | Gmail API polling on the Mini (phase 5) | Ongoing, the real engine | No (it's a pipeline) |
| **Manual single transaction** | Dashboard form | Always available | **Yes** — corrections, cash, gaps |

The CSV import is a ONE-TIME backfill of year-to-date history. Going forward, **forwarded
transaction emails from the credit cards are the primary spending feed.** Do not build a
CSV-upload screen into the app.

---

## 2. Build order (DO NOT REORDER)

Ingestion (email) is built LAST. CSV/PDF backfill comes first so the schema and dashboard are
designed against real data, and so the email pipeline has a ground-truth dataset to validate against.

1. **Schema + CSV importers (CLI)** — Postgres schema, one normalizer per format. Backfill YTD.
2. **Merchant normalization + categorization** — LLM batch-categorize, human review queue.
3. **Dashboard** — Next.js, reads Postgres, renders awareness views + manual add/edit.
4. **Lowe's PDF one-time seed** — parse the provided statement PDF once; Lowe's is manual after.
5. **Email ingestion engine (Gmail API)** — poll Gmail → extract → categorize via shared module → dedupe vs CSV data → insert into Postgres (§11b).
6. **Cash entry via email** — same pipeline, different extraction schema.
7. **Transfer detection job, loan/balance handling, backups, healthcheck, polish.**

Phases 1–3 produce a working, useful tool. Stop and use it before building 5+.

---

## 3. Tech stack

- **DB:** PostgreSQL 16 (local on the Mini).
- **Backend / importers:** Python 3.12, `psycopg` v3. CSV via stdlib `csv`. PDF (Lowe's) via `pdfplumber`.
- **LLM:** Anthropic API (Claude Haiku is plenty). Behind a swappable `llm/` interface.
- **Frontend:** Next.js (App Router) + TypeScript. Charts: Recharts. Server-render where possible.
- **Scheduler:** macOS `launchd` for nightly/weekly jobs.
- **Secrets:** `.env`, never committed.

---

## 4. The accounts (seed `accounts` table with these)

| name | institution | type | last4 | format family |
|------|-------------|------|-------|---------------|
| Chase Prime | Chase | credit_card | 6487 | Chase |
| Chase Southwest | Chase | credit_card | 7486 | Chase |
| Chase United | Chase | credit_card | 9565 | Chase |
| BofA Royal Caribbean | Bank of America | credit_card | 5142 | BofA |
| Citi | Citi | credit_card | 4559 | Citi |
| Target | Target/TD | credit_card | 1145, 1137 | Target |
| Wells Fargo | Wells Fargo | credit_card | 2355 | WellsFargo |
| Lowe's | Synchrony | credit_card | 5246 | Lowe's (PDF only) |
| Ally Checking | Ally | bank | (n/a) | Ally |
| Cash | — | cash | (n/a) | manual |

**Multiple cards → one account:** Target has two physical cards (Andy `1145`, Tina `1137`) on the
same account. The `accounts` table needs a way to map a SET of last4s to one account (e.g. an
`account_last4s` join table, or a comma-list the importer matches against). Tina likely has
authorized-user cards on other accounts too — build last4→account as many-to-one, not one-to-one.

---

## 5. The seven format families (ground truth)

**One normalizer per family.** They all map to the common schema (§7). Sign conventions and
transfer-detection differ per family — read carefully, these are the bug-prone spots.

### 5a. Chase (3 cards: 6487, 7486, 9565 — identical format)
Header: `Transaction Date,Post Date,Description,Category,Type,Amount,Memo`
- Dates `MM/DD/YYYY`. Txn Date → `occurred_at`, Post Date → `posted_at`.
- `Category` = Chase's coarse hint (`Shopping`, `Food & Drink`, `Travel`, etc.). HINT ONLY.
- `Type` ∈ {`Sale`, `Payment`, `Fee`, `Return`}.
  - `Payment` (e.g. `Payment Thank You-Mobile`, positive) → **`transfer`, is_spending=false**.
  - `Fee` (e.g. `PURCHASE INTEREST CHARGE`) → **`interest`**.
  - `Return` (positive) → **`refund`** (offsets prior spend).
  - `Sale` (negative) → spending.
- `Amount`: negative = spending, positive = inflow.
- No reference number → dedupe on composite hash (§8).
- Note merchant strings like `SOUTHWES 5262166202611`, `UNITED 0162106850942` — airline codes
  with trailing digits; fingerprint should fold to `SOUTHWEST` / `UNITED`.

### 5b. Bank of America (5142)
Header: `Posted Date,Reference Number,Payee,Address,Amount`
- One date only (`Posted Date`, `MM/DD/YYYY`) → `occurred_at`; `posted_at` null.
- `Reference Number`: stable unique ID when present → `external_id` and dedupe key.
  Blank/whitespace on interest rows → hash fallback.
- `Payee`: messy (`Vagaro_*Fitness Undergrou194-9981006 CO`, `TST*BIRDHOUSE 720-539-9099 CO`).
- `Address`: low value, store raw.
- `Amount`: negative = spending, positive = inflow.
- No category column — categorize from scratch.
- **`BA ELECTRONIC PAYMENT` (positive)** → **`transfer`** (card being paid off).
- **`INTEREST CHARGED ON PURCHASES`** → **`interest`**.

### 5c. Citi (4559)
Header: `Status,Date,Description,Debit,Credit`  ⚠️ **split debit/credit, not one signed column**
- `Status` (e.g. `Cleared`) → maps to posted/pending.
- `Date` `MM/DD/YYYY` → `occurred_at`.
- **Two amount columns:** `Debit` = spending (store as negative), `Credit` = inflow (store as
  positive). Exactly one is populated per row. Normalize to a single signed `amount`.
- `Description` embeds the full card number, e.g. `TM *JOURNEY HOLLYWOOD CA null XXXXXXXXXXXX4559`
  — **strip the `XXXX...4559` token and the literal `null`** during fingerprinting.
- No Type column → infer transfer from description keywords (payment/thank you/autopay).

### 5d. Target (1145)
Header (note **BOM** at file start): `"Transaction Date","Posting Date","Ref#","Amount","Description","Last 4 of Card/Account","Transaction Type"`
- ⚠️ **OPPOSITE SIGN CONVENTION.** A `Sale` is POSITIVE (`80.73`); a `Payment` is NEGATIVE
  (`-224.16`). **Flip the sign** so it matches everyone else (spending negative). Get this wrong
  and Target spending inverts.
- Dates `YYYY-MM-DD`.
- `Ref#` → `external_id` / dedupe key.
- `Transaction Type` ∈ {`Sale`, `Payment`, `Return`, `Fee`, `Interest`, `Adjustment`}.
  - `Payment` → **`transfer`**. `Interest`/`Fee` → **`interest`**. `Return` → **`refund`**.
  - `Adjustment` → flag for review (could be either).
- `Last 4 of Card/Account` present on some rows (`**1145`); informational.
- Strip BOM before parsing the header.

### 5e. Wells Fargo (2355)
Header: `"DATE","DESCRIPTION","AMOUNT","CHECK #","STATUS"`
- ⚠️ **No Type column.** Infer everything from `DESCRIPTION` + `STATUS`.
- Date `MM/DD/YYYY` → `occurred_at`.
- `STATUS` ∈ {`Pending`, `Posted`} → posted/pending flag.
- `Amount`: negative = spending, positive = inflow.
- **`ONLINE ACH PAYMENT THANK YOU` (positive)** → **`transfer`**.
- Merchants overlap other cards (`BIRDHOUSE`, `STARBUCKS 8007827282...`, `TOE Utilities`) — the
  shared merchant cache pays off here.

### 5f. Ally Checking (the hub — see §6 for full classification rules)
Header: `Date, Time, Amount, Type, Description`  (note leading spaces in header names — trim)
- Date `YYYY-MM-DD`; combine with `Time` for ordering if useful.
- `Type` ∈ {`Deposit`, `Withdrawal`} only — **all classification rides on `Description`.**
- `Amount`: negative = withdrawal/spending, positive = deposit/inflow.
- Descriptions carry noise like `~ Future Amount: 600 ~ Tran: ACHDW` — strip the `~ ... ~` tail.
- This is where transfers, income, mortgage, and ambiguous Zelle/Venmo/check items live. See §6.

### 5g. Lowe's (5246) — PDF ONLY, phase 4
- No CSV export available. We have a statement PDF (`lowescard.pdf`).
- Parse ONCE with `pdfplumber` to seed history, then Lowe's is **manual-entry only** going forward.
- PDF structure: blocks of `Type / Date / Status / Amount / Description`. Types: `Purchase`,
  `Refund`, `Payment`, `Fee`, `Interest`, `Autopay`.
  - In this PDF, **Purchase amounts are positive, Refund/Payment are negative** (like Target —
    flip to spending-negative).
  - `Payment`/`Autopay` → **`transfer`**. `Fee` (LATE FEE) → `fees`.
    `Interest` (`INTEREST CHARGE ON PURCHASES`, `DEFERRED INTEREST`) → **`interest`**.
  - Nearly every merchant is `STORE 3444 ERIE CO` → display "Lowe's", category `toiletries_home`
    (home improvement) by default.
  - Skip `Pending`/`Scheduled` rows (e.g. the Jun 30 scheduled autopay) — only seed `Completed`.

---

## 6. Source-of-truth model & Ally classification (CRITICAL)

**The rule that prevents double-counting:** the **card is the source of truth for card spending.**
A credit-card payment (money leaving Ally to pay a card) is NOT spending — the real purchases are
already itemized on the card. So:

- Every **card payment** (on the card side: `Payment Thank You`, `BA ELECTRONIC PAYMENT`,
  `ONLINE ACH PAYMENT THANK YOU`, Target `Payment`, Lowe's `Payment`/`Autopay`) →
  **`transfer`, is_spending=false.**
- Every matching **Ally withdrawal that pays a card** → **`transfer`, is_spending=false.**
- Ally's real contribution to spending = **income + checking-origin bills/purchases that never
  hit a card.**

Going forward (email era) the cards' purchase/refund emails are the bulk of spending; this CSV
backfill is one-time. Build with that future in mind.

### Ally description → classification (seed rules; importer applies deterministically)

| Description contains… | classification | category |
|---|---|---|
| `CHASE CREDIT CRD EPAY`, `WELLS FARGO CARD CCPYMT`, `TARGET CARD SRVC PAYMENT`, `Lowes SYF PAYMNT`, `APPLECARD GSBANK PAYMENT`, `BANK OF AMERICA ONLINE PMT` | transfer | — |
| `Internet transfer to/from Spending account`, `Requested transfer from Ally Invest`, `JPMorgan Chase Ext Trnsfr` | transfer | — |
| `ROCKET MORTGAGE LOAN` | spending | `housing` |
| `PL*NeighborhoodN` (~$112/mo HOA — incl. trash/neighborhood) | spending | `housing` |
| `CATERPILLAR INC. DIR DEP` | income | `income` |
| `Interest Paid`, `ATM Fee Reimbursement` | income | `income` |
| `VENMO CASHOUT` (+) and other Zelle/Venmo **deposits in** (Tina selling household items) | income | `misc_income` |
| `XCEL ENERGY`, `TOE Utilities` | spending | `utilities` |
| `Tesla_US_Captive…Energy_Lease` (solar/Powerwall lease — NOT the car) | spending | `utilities` |
| `TESLA MOTORS` (vehicle/FSD) | spending | `automotive` |
| `KODA COLORADO` | spending | `fitness` |
| `PARAMOUNT ACCEPT VASAFIT`, `NOBULL`/`SP NOBULL` | spending | `fitness` |
| `Zelle … to KELLY MAILLY` | spending | `pets` |
| `POPPINS` | spending | `childcare` |
| `Zelle … to BLUTERRA INC` | **business_expense** (is_spending=false — see §9) | `business_expense` |
| `Check Paid #NNNN` (no description) | spending | **`needs_review`** (auto-flagged for weekly pass) |
| `BANK OF AMERICA *…ROSENBERG` | spending | `needs_review` (looks like ATM/cash) |
| `VENMO PAYMENT` (−, outgoing) | spending | `needs_review` (ambiguous) |
| anything unmatched | spending | `uncategorized` (review queue) |

These seed rules run in code; the LLM handles the long tail; humans confirm ambiguous ones once
(then `locked`). **Expect to review most non-obvious Ally rows once** — unlike cards, checking is
review-heavy by nature.

**`needs_review` vs `uncategorized` — two different buckets:**
- `uncategorized` = the system didn't recognize the merchant. Should shrink toward zero as the
  merchant cache learns. A failure state to drive down.
- `needs_review` = the system knows it *can't* know without a human (bare checks, ambiguous
  Venmo, possible ATM withdrawals). A permanent, intentional bucket. These surface in the weekly
  review pass for manual assignment and are NOT auto-resolved by the LLM.

---

## 7. Database schema

```sql
CREATE TABLE accounts (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  institution TEXT,
  type        TEXT NOT NULL,        -- 'credit_card' | 'bank' | 'loan' | 'cash'
  last4       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE merchants (
  id               SERIAL PRIMARY KEY,
  raw_fingerprint  TEXT UNIQUE NOT NULL,   -- normalized clustering key (§8)
  display_name     TEXT NOT NULL,          -- "Starbucks", "Birdhouse", "Lowe's"
  default_category TEXT,
  locked           BOOLEAN DEFAULT false,  -- human-confirmed; LLM won't overwrite
  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE transactions (
  id             SERIAL PRIMARY KEY,
  account_id     INTEGER NOT NULL REFERENCES accounts(id),
  occurred_at    DATE NOT NULL,
  posted_at      DATE,
  amount         NUMERIC(12,2) NOT NULL,    -- signed: negative = spending, positive = inflow
  merchant_id    INTEGER REFERENCES merchants(id),
  merchant_raw   TEXT NOT NULL,
  category       TEXT,
  txn_type       TEXT NOT NULL DEFAULT 'sale', -- sale|payment|fee|return|transfer|income|business_expense|cash
  is_spending    BOOLEAN NOT NULL DEFAULT true, -- false for transfer/income/misc_income/refund/business_expense; drives totals
  source         TEXT NOT NULL,             -- 'csv' | 'pdf' | 'email' | 'cash_email' | 'manual'
  external_id    TEXT,                      -- BofA ref / Target ref# when present
  dedupe_key     TEXT UNIQUE NOT NULL,      -- idempotent imports (§8)
  user_corrected BOOLEAN DEFAULT false,
  confidence     REAL,
  is_deleted     BOOLEAN NOT NULL DEFAULT false, -- soft delete for manual removals
  raw_payload    JSONB,                     -- original row / raw email for re-processing
  notes          TEXT,
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_txn_occurred ON transactions(occurred_at);
CREATE INDEX idx_txn_category ON transactions(category);
CREATE INDEX idx_txn_merchant ON transactions(merchant_id);
CREATE INDEX idx_txn_spending ON transactions(is_spending) WHERE is_deleted = false;

-- transaction_splits: optional per-transaction category breakdown, stored as PERCENTAGES.
-- A transaction with zero split rows uses transactions.category (the common case).
-- A transaction with split rows has its category derived from the splits instead.
CREATE TABLE transaction_splits (
  id             SERIAL PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category       TEXT NOT NULL,
  percent        NUMERIC(5,2) NOT NULL CHECK (percent > 0 AND percent <= 100),
  notes          TEXT,
  created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_split_txn ON transaction_splits(transaction_id);
-- App-level invariant (not a DB constraint): for any transaction, SUM(percent) = 100.
-- The edit UI enforces this; won't save until the running total is exactly 100.
```

---

## 8. Dedupe + fingerprinting

**Idempotent imports** — re-running over an overlapping file inserts 0 new rows.
`dedupe_key` per family:
- **BofA:** ref present → `"bofa:"+ref`; blank → `"bofa:"+sha1(date|amount|payee)`.
- **Target:** `"target:"+ref#`.
- **Chase:** `"chase:"+sha1(txn_date|post_date|amount|description)` (no ref).
- **Citi:** `"citi:"+sha1(date|amount|description)`.
- **Wells Fargo:** `"wf:"+sha1(date|amount|description|status)`.
- **Ally:** `"ally:"+sha1(date|time|amount|description)` (time disambiguates same-day dupes).
- **Lowe's PDF:** `"lowes:"+sha1(date|amount|description|type)`.

Insert `ON CONFLICT (dedupe_key) DO NOTHING`.

**Merchant fingerprint** (`raw_fingerprint`): uppercase → strip prefixes (`SQ *`, `TST*`,
`TM *`, `SP `, `PL*`) → strip trailing phone numbers, state tails (` CO`/` CA`/` WA`/` TX`/etc.),
card-number tokens (`XXXX…`), the literal `null`, Ally's `~ … ~` tail, and trailing ref digits →
collapse whitespace. Must collapse e.g.:
- `STARBUCKS 8007827282 800-782-7282 WA` → `STARBUCKS`
- `TST*BIRDHOUSE 720-539-9099 CO` → `BIRDHOUSE`
- `SOUTHWES 5262166202611` → `SOUTHWEST`; `UNITED 0162106850942` → `UNITED`
- `TARGET T-2205 ROSENBERG TX`, `TARGET.COM * 800-591-3869 MN`, `TARGET 00019083 KATY TX` → `TARGET`

Heuristic only; LLM does final display-name + category, review queue catches stragglers.

---

## 9. Category taxonomy (v1)

Flat (no subcategories). Refined from the original draft + everything the real files surfaced
(pets, travel, housing, income, transfers were missing or implied).

**Spending** (`is_spending=true`): `groceries` (Whole Foods, Sprouts, Natural Grocers, King
Soopers, Walmart, Target — incl. baby formula), `eating_out` (actual meals — Chipotle, Chick-fil-A,
Wendy's, Texas Roadhouse, restaurants + fast-casual), `coffee_snacks` (informal grab-and-go treats —
Starbucks croissant, Sweet's ice cream, the local cookie place; discretionary and the easiest spend
to trim, so it's deliberately its own line), `utilities`
(Xcel, Tesla Energy/solar lease), `housing` (mortgage — Rocket;
HOA — `PL*NeighborhoodN` ~$112/mo incl. trash; rent), `home_entertainment` (at-home media — YouTube
Premium, Netflix, Spotify, Prime Video purchases, Xbox/game purchases, TouchTunes),
`outings_activities` (going out to DO something, not eat — Dave & Buster's, arcades, bowling, AMC,
claw machines), `fitness` (Vagaro, VASAFIT/Paramount, NoBull, Koda Colorado), `medical` (Midi
Health, Walgreens Rx), `wellness` (massages/spa), `automotive` (Tesla vehicle/FSD — NOT the energy
lease, car wash, Hagerty), `insurance`, `toiletries_home` (Lowe's home improvement, dollar stores,
household
toiletries), `childcare` (paid care SERVICES only — Poppins, daycare, babysitters, Chuck E. Cheese
as kid activity), `kid_expenses` (goods FOR the kids, all three — diapers (Costco), kids' clothing,
gear, toys; the DEFAULT for Costco), `pets` (Chewy, VetSource, Zelle→Kelly Mailly), `travel`
(Royal Caribbean/cruises, airlines, Hilton, Journey Hollywood), `giving`, `gifts` (UberPrints),
`personal_andy` (Andy's discretionary — Grok, Claude, X, Audible, books), `personal_tina`
(Tina's discretionary — her subscriptions/hobbies), `shopping` (general/Amazon catch-all),
`interest` (CC + loan interest), `fees` (late fees), `needs_review` (inherently ambiguous — checks,
some Venmo, possible ATM; permanent manual bucket), `uncategorized` (unrecognized merchant — should
trend to zero).

**Non-spending** (`is_spending=false`, excluded from spending totals): `transfer` (CC payments,
inter-account moves, Ally→card), `income` (Caterpillar direct deposit, interest paid),
`misc_income` (Tina selling household items via Zelle/Venmo deposits), `refund` (returns),
`business_expense` (Zelle→Bluterra — money leaves the household but is NOT family consumption;
kept off the family-spending number, visible as its own line; may be reimbursed/deductible/netted
against business income tracked elsewhere).

Notes: `interest` and `fees` are spending but dashboard-toggleable (cost-of-debt, not discretionary).
`travel` may later split out `cruises` given volume — keep one bucket for v1. **HOA defaulted to
`housing`** so mortgage + HOA together answer "what does this house cost"; switch to `utilities`
if you think of it as a recurring household bill. **`business_expense` is is_spending=false** by
design — flip to true only if you want business outflow inside the family spend number.

---

## 10. Categorization logic (precedence)

1. `txn_type` payment/transfer → `transfer`, is_spending=false. Done.
2. Interest/fee patterns → `interest`/`fees`.
3. Ally seed rules (§6) for the checking account.
4. Merchant exists + `locked` → use its default_category.
5. Else LLM: pass `{merchant_raw, amount, issuer_category_hint, account_type, taxonomy}` → strict
   JSON `{display_name, category, confidence}`.
6. Write/update merchant cache (never overwrite `locked`).
7. `confidence < 0.7` → flag for review queue.

**Learning rule:** human edits a transaction's category → `user_corrected=true` on that txn. If
they pick "apply to this merchant going forward" → set merchant `default_category` + `locked=true`.
One-off (a Target grocery run) edits only the txn; merchant default stays.

**Mixed-merchant defaults** (stores selling across many categories — assign a sensible default,
split only when it matters):
- **Target → `groceries`** (formula is being weaned onto real food anyway, so formula folds into groceries — simpler and a shrinking line; split off occasional clothing/household if a run warrants it)
- **Costco → `kid_expenses`** (60–70% is diapers; split off the groceries/toilet paper/household portion on big runs)
- **Walmart → `groceries`**
- **Amazon → `shopping`**
- **Whole Foods, Sprouts, Natural Grocers → `groceries`** (the household's ACTUAL grocery merchants — lock these defaults early; they auto-classify cleanly and keep the `groceries` number meaningful)

Rationale: groceries happen at Whole Foods/Sprouts/Natural Grocers/Target (formula included), so
only Costco defaults to `kid_expenses` (diaper-dominant). This keeps both numbers clean —
`groceries` = grocery + formula runs, `kid_expenses` = diapers + kids' goods — and leans on
splits/templates for the mixed portion of the Costco runs.

### Transaction splits (percentage-based)

A transaction may be broken into category lines stored as **percentages** in `transaction_splits`
(§7). Percentages are used precisely so the splits ALWAYS sum to the parent total regardless of the
amount — no reconciliation math, and they survive amount corrections (re-derive automatically).

- The edit UI shows a live running total; **won't save until percentages sum to exactly 100**.
- Each line shows the **derived dollar amount** (`parent_amount × percent`) next to the percentage
  as you type/drag, e.g. "Target $224.16 → kid_expenses 40% = $89.66".
- **Rounding:** derive each line, then assign rounding remainder (a cent or two) to the LARGEST
  split via largest-remainder, so displayed dollars reconcile to the parent exactly.
- **Split templates per merchant:** once a merchant is split similarly 2–3 times, offer the prior
  split as a one-tap template. This is what makes splitting fast enough to actually do.
- **Phase-2 OCR path:** receipt capture extracts line items as dollars → convert to percentages →
  populate the same split lines. Same data model; the receipt is just a faster input. Build the
  percentage split model now so OCR slots in later without migration.

### Splits-aware totals (the one query that MUST be right)

For all category/vendor aggregation:
- Transaction with **no split rows** → counts its full `amount` under `transactions.category`.
- Transaction **with split rows** → counts `amount × percent/100` under each split's category;
  **does NOT also count under the parent category** (that would double-count).
- Never sum parent + splits together. A transaction is categorized EITHER by its own category OR by
  its splits, never both.

### Learning over time (how the system gets sharper)

No ML, no model training — the **merchant cache IS the learning system.** The loop:

1. New merchant → fingerprinted, no cache hit → LLM guesses category → stored **unlocked**.
2. Human confirms/corrects in the review queue. Choosing "always categorize [Ziggi's] as
   coffee_snacks" sets the merchant's `default_category` + `locked=true`.
3. Every future transaction from that merchant **skips the LLM** — instant, free, consistent.

Because spending is dominated by repeat merchants (same grocery store, same coffee shop), this
alone makes the system faster and more accurate every week. `uncategorized` should trend toward
zero; if it doesn't, the fingerprint normalizer is splitting a merchant that should collapse.

**Few-shot from your own history (build this in from the start, not bolted on):** when the LLM
must categorize a genuinely NEW merchant, first pull ~15–20 of your already-`locked`
merchant→category pairs from the DB and include them in the prompt as examples ("This household
files: Ziggi's→coffee_snacks, Audible→personal_andy, Sweet's→coffee_snacks, Koda→fitness …").
The model then generalizes from YOUR taste, not a generic prior. The example set grows as you
categorize more, so first-guess accuracy on new merchants improves over time. This is a DB query +
a richer prompt — nothing more.

**Optional `category_corrections` log** (nice-to-have, not core): `(merchant_id, old_category,
new_category, corrected_at)`. Lets you later see which merchants you keep re-correcting — i.e.
where the system struggles — and could feed a future fine-tune if ever wanted (almost certainly
unnecessary at a few-hundred-merchant scale).

**The one-off guard (restated, because it's what makes auto-learning not-infuriating):** a single
transaction recategorization edits ONLY that transaction. The merchant default changes ONLY when
the human explicitly picks "apply to this merchant going forward." Never over-learn from one
exception.

---

## 11. Dashboard (phase 3) — two pages, savings-focused

Build against real loaded data. Totals exclude `is_spending=false` and `is_deleted=true`.

**The app's purpose is not just awareness — it's to help the household spend less and save more.**
"We are currently spending too much and need to be saving." That goal shapes the design: the
landing view should make the savings picture vivid and emphasize PROGRESS (are we improving?), not
just STATE (are we negative?), since progress motivates where a standing red number demoralizes.
Keep framing neutral and factual, never scolding — this is a shared tool for two people.

**Three pages**, lightweight top nav: **Overview · Transactions · Subscriptions**, with a
**persistent "+ Add expense"** button in the header (available from any page). Review folds into
the top of Transactions (see below) — it's not a separate page.

### Page 1 — Overview (landing page): "How are we doing?"

A glanceable savings dashboard. Big numbers, the trend, red/green.

- **Yearly health strip (very top):** Yearly Income · Yearly Expenses · **Net** (green positive /
  red negative) · **Savings rate / "saved $X" or "overspent $X" this year**. This is the headline
  answer to "are we saving."
- **Monthly bar chart (Jan → current):** one bar per month.
  - Under each month: **net for that month, color-coded** (green positive / red negative) and the
    income figure. The eye should land on red months instantly.
  - **Trend indicator** — direction over recent months ("net improving 3 months running" /
    "widening" / "stabilizing"). Progress is the motivating signal, not just the level.
  - Faint **average-month line** so a tall bar reads as "above normal" at a glance.
  - **Clicking a bar/month → navigates to Transactions** scoped to that period.
  - **Category dropdown above the chart:** default **"All expenses"**; selecting a category
    (e.g. `coffee_snacks`) re-renders the bars to that ONE category per month, for quick
    month-over-month comparison. This is the "did our cut actually stick?" view — high value for
    the savings goal.

### Page 2 — Transactions: attention → range → summary → detail

One coherent working surface, sequenced top to bottom: what needs me, what range, how we did,
where it went, the line items.

**A. "To review" section (top) — ALWAYS all-time, ignores the date filter below.**
- Surfaces every transaction needing attention: `needs_review` (checks, ambiguous Venmo/ATM),
  `uncategorized` (unrecognized merchant), and low-confidence (`confidence < 0.7`) guesses —
  across ALL time and accounts, NOT scoped to the selected period. (Rationale: a flagged check
  from January must not hide because you're viewing March. Flagged = clean up regardless of date.)
- Each item resolves inline in the edit/categorize modal; confirming offers "apply to this merchant
  going forward" (§10 learning rule).
- **Empty state:** collapses to a friendly "All caught up ✓" / "You're all up to date" message —
  a small reward that makes the weekly review ritual something you do rather than avoid.

**B. Date selector + filters — controls everything in C–E below (NOT section A).**
- Date: defaults to current month; switchable to any month, **full year (2026)**, or **custom
  range** (Bluterra `DateRangeSelector`). Honors the period clicked from Overview.
- Filters: **category** and **account** (so "all Target this year" or "coffee_snacks in March" is a
  filter, not a scroll). Optional merchant text search.

**C. Period summary breakout** (for the selected range):
- **Total income · Total expenses · Net** — net labeled **"saved $X"** (green) when positive or
  **"overspent $X"** (red) when negative. The savings goal, restated for this period.
- **Pie chart** (to the right of the numbers): share-of-spend by category. With ~25 categories a
  literal pie is confetti — show **top 6–8 slices + "Other"**; the full breakdown lives in D.

**D. Top categories** (highest → lowest, amount + % of period; splits-aware, §10) and **top
vendors** (highest → lowest spend, with txn count).

**E. Transaction list** for the period. Columns: date, merchant (display; raw on hover), amount,
account (last4 / "Cash"), category, type. **Click a row → edit/split modal.**

### Page 3 — Subscriptions (build early, not phase 2)

Given the savings goal, recurring charges graduate from "nice-to-have" to early-build: subscriptions
are the easiest dollars to cut, and you can't cut what you can't see. Detect merchants charging on
a ~monthly cadence (Netflix, Spotify, YouTube Premium, X, Claude, Audible, insurance, HOA, mortgage)
and list them with monthly amount + annualized cost. A "$14.99/mo = $180/yr" framing makes the
trim-or-keep decision obvious.

### Shared interactions
- **Manual add** — date, amount, merchant, category, account (incl. Cash), notes.
  `source='manual'`, dedupe_key from UUID.
- **Manual edit** — any field; sets `user_corrected=true`. **Soft-delete** (`is_deleted=true`), never hard delete.
- **Split** — category lines as percentages summing to 100 (§10), derived dollars shown live,
  per-merchant split templates offered. Optional; most transactions never split.
- **Categorize → learning** — confirming/correcting a category offers "apply to this merchant going
  forward" (sets merchant default + locked, §10).

### Design direction — Bluterra-inspired, DARK theme, calmer than Bluterra

Keep the **Bluterra DNA**: card-based layout, rounded-2xl cards, generous spacing, Recharts,
lucide icons, the overall sense of craft. Andy built and liked that dashboard; match that quality
bar. **Dark theme confirmed.**

**But adapt the surface for a data-dense daily-driver** (Bluterra's heavy glassmorphism suited a
monitoring dashboard, not financial tables read for years):
- **Ease off heavy glassmorphism for the data-dense parts.** `backdrop-blur` + translucent
  white-on-slate + `text-gray-400` labels is lovely for a few hero metrics but a legibility tax on
  a transaction table. Use a **dark surface with REAL contrast** where data is dense (transaction
  list, category/vendor lists) — readable text, not low-opacity gray.
- **Reserve saturated color for MEANING.** Green/red mean money direction (net positive/negative,
  income/spending) — NOT decoration, and NOT Bluterra's above/below-threshold semantics. One
  additional accent used sparingly.
- **Money is the hero:** tabular numerals everywhere money appears, right-aligned amounts.
- Distinctive but readable type pairing (NOT Inter/Roboto/Arial). No purple-gradient AI slop.

Reusable from Bluterra with light adaptation: `DateRangeSelector` (period selection on Month page),
`MetricsCards` (the summary-number cards → yearly health strip + period summary), the Recharts bar
setup (→ monthly net/spend chart), the table styling in `TopCustomersTable`/`TipEventsTable`
(→ transaction list, category/vendor lists). Re-skin: green/red = money direction, higher contrast.

---

## 11b. Email ingestion (phase 5) — Gmail API polling

Decision: poll Gmail directly via the Gmail API on a schedule, rather than an inbound-email
webhook service. Since all bank/card alerts already route through the household Gmail, polling our
own inbox is fewer moving parts and keeps no third party in the path. Runs on the Mini via launchd
every ~10 min. **This is a new ingestion SOURCE that feeds the EXISTING pipeline — not a separate
system.** Its extracted transactions go through the same normalization, `dedupe_key`, merchant
cache, and categorization precedence (§10) as the CSV importers, written into the same Postgres
`transactions` table with `source='email'`.

Critical implementation rules (these correct common quick-tutorial mistakes):

1. **Do NOT use Gmail read/unread state to track processing.** Both humans read this inbox; an
   alert opened on a phone would be skipped, and the script marking things read pollutes the inbox.
   **The Postgres DB is the source of truth for "already processed."** Query Gmail by date range,
   capture each message's Gmail `message_id`, and skip IDs already stored (store it on the
   transaction's `raw_payload` or a small `processed_emails` table). This lets us use the narrowest
   scope, `gmail.readonly`, and touch nothing in the inbox. (A `finance-processed` label +
   `gmail.modify` is an acceptable alternative, but DB-tracked + readonly is cleaner.)

2. **Write into Postgres, not SQLite/JSON.** Same DB, same schema, same dedupe path. An emailed
   transaction and its later statement-CSV version must collapse to ONE row on `dedupe_key`.

3. **Extract, then categorize through the shared module — do not free-categorize.** The LLM (or a
   parser) pulls `{amount, merchant_raw, date, last4}` from the email. Categorization then runs the
   SAME precedence as everything else: locked merchant cache first, LLM only for new merchants,
   against OUR taxonomy. Never let the email path assign categories from a generic ad-hoc list — it
   would bypass everything the merchant cache has learned.

4. **Strip the email before the LLM sees it.** Bank alerts are ~90% boilerplate. Regex out the
   transaction-relevant lines and send only those — cheaper, and less account data leaves the Mini.

5. **Alerts ≠ posted.** Alert emails fire at swipe time; amounts can change before posting (tips,
   gas holds). Treat email transactions as early/pending; the eventual statement CSV reconciles via
   `dedupe_key`. Expect occasional small amount differences — that's normal, not a bug.

Scope: `gmail.readonly` (DB-tracked processing). Credentials: OAuth desktop `credentials.json` +
cached `token.json`, never committed.

### Cash via email (phase 6)
Same pipeline, different extraction schema. A dedicated convention (e.g. subject `$12 Joe's Coffee`)
the LLM parses into a manual-style transaction. Note: **manual cash entry in the web app (§11.6)
already works from day one** — email cash is just a faster optional path added later, not the only
way to log cash.

---



Budgets/targets, net-worth tracking, investment tracking, forecasting, per-user (his/hers) views,
mobile app, automated Lowe's import (manual after PDF seed). Phase 2 starts after v1 runs clean.

**Phase-2 candidates (noted so v1 doesn't block them, NOT built now):**
- **OCR receipt capture** — feeds the existing percentage-split model (§10); receipt line items →
  percentages. Data model already built for it.
- **Budgets/targets** — the original phase-2 goal once awareness data has accumulated; the
  `coffee_snacks`/discretionary categories are pre-isolated to make targets actionable.
- **Few-shot fine-tune** — only if the few-shot-from-history prompt (§10) ever disappoints, which
  it likely won't at this scale.

(NOTE: Recurring/subscription detection was promoted OUT of phase 2 → built early as Overview
Page 3, §11, because the household's stated goal is to save and subscriptions are the easiest cut.)

---

## 13. First tasks for Cursor (start here)

1. Scaffold: `/importers` (one module per family + `common.py`), `/db` (schema.sql), `/llm`, `/web` (Next.js), `/jobs`, `/drop` (CSV inbox).
2. Postgres up locally, apply `schema.sql`, seed `accounts` (§4).
3. `importers/common.py`: fingerprinting (§8), dedupe-key, signed-amount normalization, upsert, `~…~`/BOM/card-token stripping helpers.
4. Per-family normalizers: `chase.py`, `bofa.py`, `citi.py`, `target.py` (SIGN FLIP), `wellsfargo.py`, `ally.py` (§6 rules). Each maps to common schema; imports idempotent.
5. `importers/run.py ./drop` — detect family per file (by header signature), route, import.
6. Run all provided CSVs. Validate (checklist below).
7. `llm/categorize.py` (§10) behind swappable provider. Batch-categorize.
8. Then dashboard (§11), incl. manual add/edit.
9. Then Lowe's PDF seed (`importers/lowes_pdf.py`, §5g).

**Validation checklist after step 6:**
- [ ] All card `Payment`/`Payment Thank You`/`BA ELECTRONIC PAYMENT`/`ONLINE ACH PAYMENT THANK YOU`/Target `Payment` → `transfer`, is_spending=false.
- [ ] All Ally `… CRD EPAY / CARD … PAYMENT / SYF PAYMNT` → `transfer`.
- [ ] Target `Sale` rows are POSITIVE in source but stored NEGATIVE (spending). Spot-check a known purchase.
- [ ] Citi `Debit` → negative amount; `Credit` → positive.
- [ ] `ROCKET MORTGAGE LOAN` and HOA (`PL*NeighborhoodN`) → `housing`, is_spending=true.
- [ ] `CATERPILLAR INC. DIR DEP` → `income`; Zelle/Venmo deposits in → `misc_income`; both is_spending=false.
- [ ] `Zelle → BLUTERRA` → `business_expense`, is_spending=false (NOT in family spend total).
- [ ] `Zelle → KELLY MAILLY` → `pets`; `KODA COLORADO`/`NOBULL` → `fitness`; `POPPINS` → `childcare`.
- [ ] `Tesla…Energy_Lease` → `utilities` (NOT automotive); `TESLA MOTORS` → `automotive`.
- [ ] `Check Paid #NNNN` → `needs_review` (not silently bucketed); appears in review queue.
- [ ] Interest rows (BofA, Chase Fee, Target Interest, Lowe's) → `interest`.
- [ ] Re-running any importer inserts 0 new rows.
- [ ] Same merchant across cards (Birdhouse, Starbucks) collapses to one `merchants` row.
- [ ] Sum of is_spending=true ≈ gut-check of real monthly spend (no card-payment inflation).
