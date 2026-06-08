-- Seed accounts. Apply after schema.sql:
--   psql "$DATABASE_URL" -f db/seed_accounts.sql

INSERT INTO accounts (name, institution, type) VALUES
  ('Chase Prime',          'Chase',           'credit_card'),
  ('Chase Southwest',      'Chase',           'credit_card'),
  ('Chase United',         'Chase',           'credit_card'),
  ('BofA Royal Caribbean', 'Bank of America', 'credit_card'),
  ('Citi',                 'Citi',            'credit_card'),
  ('Target',               'Target/TD',       'credit_card'),
  ('Wells Fargo',          'Wells Fargo',     'credit_card'),
  ('Lowe''s',              'Synchrony',       'credit_card'),
  ('Ally Checking',        'Ally',            'bank'),
  ('Cash',                 NULL,              'cash')
ON CONFLICT DO NOTHING;

-- Map card last4s to accounts. Target has TWO cards on ONE account (1145 Andy, 1137 Tina).
INSERT INTO account_last4s (account_id, last4)
SELECT id, v.last4 FROM accounts a
JOIN (VALUES
  ('Chase Prime','6487'),
  ('Chase Southwest','7486'),
  ('Chase United','9565'),
  ('BofA Royal Caribbean','5142'),
  ('Citi','4559'),
  ('Target','1145'),
  ('Target','1137'),
  ('Wells Fargo','2355'),
  ('Lowe''s','5246')
) AS v(name, last4) ON a.name = v.name
ON CONFLICT (last4) DO NOTHING;
