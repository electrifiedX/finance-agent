-- Family Finance Tracker — Postgres schema
-- Apply with: psql "$DATABASE_URL" -f db/schema.sql

-- ---------------------------------------------------------------------------
-- accounts: every funding source (card, bank, loan, cash)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  institution TEXT,
  type        TEXT NOT NULL,        -- 'credit_card' | 'bank' | 'loan' | 'cash'
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- account_last4s: many last4s -> one account (Target has two cards on one account;
-- Tina has authorized-user cards on other accounts too). Importers match a row's
-- last4 (or the importer's default account for that file) to an account via this table.
CREATE TABLE IF NOT EXISTS account_last4s (
  id         SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  last4      TEXT NOT NULL UNIQUE
);

-- ---------------------------------------------------------------------------
-- merchants: normalization + default-category cache. THIS is the learning system.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS merchants (
  id               SERIAL PRIMARY KEY,
  raw_fingerprint  TEXT UNIQUE NOT NULL,   -- normalized clustering key
  display_name     TEXT NOT NULL,          -- "Starbucks", "Birdhouse", "Lowe's"
  default_category TEXT,
  locked           BOOLEAN DEFAULT false,  -- human-confirmed; LLM won't overwrite
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- transactions: the normalized event, one row per real-world transaction
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id             SERIAL PRIMARY KEY,
  account_id     INTEGER NOT NULL REFERENCES accounts(id),
  occurred_at    DATE NOT NULL,
  posted_at      DATE,
  amount         NUMERIC(12,2) NOT NULL,        -- signed: negative = spending, positive = inflow
  merchant_id    INTEGER REFERENCES merchants(id),
  merchant_raw   TEXT NOT NULL,
  category       TEXT,
  txn_type       TEXT NOT NULL DEFAULT 'sale',  -- sale|payment|fee|return|transfer|income|business_expense|cash
  is_spending    BOOLEAN NOT NULL DEFAULT true, -- false for transfer/income/misc_income/refund/business_expense
  source         TEXT NOT NULL,                 -- 'csv' | 'pdf' | 'email' | 'cash_email' | 'manual'
  external_id    TEXT,                          -- BofA ref / Target ref# when present
  dedupe_key     TEXT UNIQUE NOT NULL,          -- idempotent imports
  user_corrected BOOLEAN DEFAULT false,
  confidence     REAL,
  is_deleted     BOOLEAN NOT NULL DEFAULT false,
  raw_payload    JSONB,                         -- original row / raw email for re-processing
  notes          TEXT,
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_txn_occurred ON transactions(occurred_at);
CREATE INDEX IF NOT EXISTS idx_txn_category ON transactions(category);
CREATE INDEX IF NOT EXISTS idx_txn_merchant ON transactions(merchant_id);
CREATE INDEX IF NOT EXISTS idx_txn_spending ON transactions(is_spending) WHERE is_deleted = false;

-- ---------------------------------------------------------------------------
-- transaction_splits: optional per-transaction breakdown, stored as PERCENTAGES.
-- A txn with zero split rows uses transactions.category. A txn with split rows is
-- categorized BY the splits (never both — see aggregation in db/queries.sql).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transaction_splits (
  id             SERIAL PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category       TEXT NOT NULL,
  percent        NUMERIC(5,2) NOT NULL CHECK (percent > 0 AND percent <= 100),
  notes          TEXT,
  created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_split_txn ON transaction_splits(transaction_id);
-- App-level invariant (enforced in UI, not DB): SUM(percent) per transaction = 100.

-- ---------------------------------------------------------------------------
-- split_templates: remembered per-merchant split patterns (one-tap reuse).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS split_templates (
  id           SERIAL PRIMARY KEY,
  merchant_id  INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  lines        JSONB NOT NULL,   -- [{"category":"groceries","percent":60}, ...]
  created_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE (merchant_id)
);

-- ---------------------------------------------------------------------------
-- category_corrections: audit log of recategorizations (nice-to-have).
-- Lets you see which merchants you keep re-correcting (where the system struggles).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS category_corrections (
  id            SERIAL PRIMARY KEY,
  merchant_id   INTEGER REFERENCES merchants(id) ON DELETE SET NULL,
  transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  old_category  TEXT,
  new_category  TEXT,
  corrected_at  TIMESTAMPTZ DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- processed_emails: phase-5 Gmail dedupe (DB is source of truth, NOT read/unread).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS processed_emails (
  id            SERIAL PRIMARY KEY,
  gmail_msg_id  TEXT UNIQUE NOT NULL,
  processed_at  TIMESTAMPTZ DEFAULT now(),
  transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL
);
