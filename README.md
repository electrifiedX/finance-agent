# finance-agent

A self-hosted family finance tracker. Ingests bank/card CSVs (and later, forwarded transaction
emails), categorizes transactions with a learning merchant cache, and shows a dark, savings-focused
dashboard: how are we doing this year, and where did the money go.

**Start here:** `SETUP.md` (runbook) and `docs/BRIEF.md` (full spec).

## Layout
```
db/          schema.sql, seed_accounts.sql, queries.sql (dashboard aggregations)
importers/   common.py (fingerprint/dedupe/upsert) + one parser per bank + run.py
llm/         categorize.py (merchant cache + few-shot-from-history LLM)
jobs/        (phase 5) Gmail ingestion
drop/        put bank CSVs here to import (gitignored)
web/         (you build this with Cursor) Next.js dashboard
docs/BRIEF.md the complete spec
```

## Quick start
```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # fill in DATABASE_URL + ANTHROPIC_API_KEY
psql "$DATABASE_URL" -f db/schema.sql
psql "$DATABASE_URL" -f db/seed_accounts.sql
cp ~/exports/*.csv ./drop/ && python -m importers.run ./drop
python -m llm.categorize
```
Then build the dashboard — see `SETUP.md` Part B for the exact Cursor Composer prompts.

## Build order
1. Schema + importers (done) → 2. Categorization (done) → 3. Dashboard (Cursor) →
4. Lowe's PDF seed → 5. Gmail ingestion → 6. Cash via email → 7. polish.

Phases 1–3 give a working tool. Use it before building 5+.
